import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as reviewApi from "@/lib/review";
import type { Document } from "@/lib/review";

export const Route = createFileRoute("/review")({
  component: ReviewQueuePage,
});

// Category info for display
const categoryNames: Record<string, string> = {
  Udostoverenie: "Удостоверение",
  Diplom: "Диплом/Аттестат",
  ENT: "ЕНТ",
  Lgota: "Льгота",
  Unclassified: "Неизвестно",
  Privivka: "Прививочный паспорт",
  MedSpravka: "Медицинская справка",
};

function ReviewQueuePage() {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "queued" | "in_review">(
    "queued"
  );
  const [searchTerm, setSearchTerm] = useState("");

  // Preview state
  const [preview, setPreview] = useState<reviewApi.DocumentPreview | null>(
    null
  );
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Review form state
  const [finalCategory, setFinalCategory] = useState("");
  const [applicantName, setApplicantName] = useState("");
  const [applicantLastname, setApplicantLastname] = useState("");
  const [comment, setComment] = useState("");

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: "/login" });
    }
  }, [isAuthenticated, navigate]);

  // Load documents
  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    try {
      const docs = await reviewApi.getReviewQueue({
        status: filter === "all" ? undefined : filter,
      });
      setDocuments(docs);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load queue";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (isAuthenticated) {
      loadDocuments();
    }
  }, [isAuthenticated, loadDocuments]);

  // Load preview when document selected
  useEffect(() => {
    if (selectedDoc) {
      setIsLoadingPreview(true);
      reviewApi
        .getDocumentPreview(selectedDoc.id)
        .then(setPreview)
        .catch((error) => {
          console.error("Failed to load preview:", error);
          setPreview(null);
        })
        .finally(() => setIsLoadingPreview(false));

      // Initialize form
      setFinalCategory(selectedDoc.category_predicted);
      setApplicantName(selectedDoc.applicant_name);
      setApplicantLastname(selectedDoc.applicant_lastname);
      setComment("");
    }
  }, [selectedDoc]);

  // Claim document
  const handleClaim = useCallback(async (doc: Document) => {
    try {
      const updated = await reviewApi.claimDocument(doc.id);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? updated : d)));
      setSelectedDoc(updated);
      toast.success("Document claimed");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to claim";
      toast.error(message);
    }
  }, []);

  // Release document
  const handleRelease = useCallback(
    async (doc: Document) => {
      try {
        const updated = await reviewApi.releaseDocument(doc.id);
        setDocuments((prev) =>
          prev.map((d) => (d.id === doc.id ? updated : d))
        );
        if (selectedDoc?.id === doc.id) {
          setSelectedDoc(null);
        }
        toast.success("Document released");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to release";
        toast.error(message);
      }
    },
    [selectedDoc]
  );

  // Resolve document
  const handleResolve = useCallback(async () => {
    if (!selectedDoc) return;

    if (!finalCategory) {
      toast.error("Please select a category");
      return;
    }

    try {
      const updated = await reviewApi.resolveDocument(selectedDoc.id, {
        final_category: finalCategory,
        applicant_name: applicantName,
        applicant_lastname: applicantLastname,
        comment: comment || undefined,
      });

      setDocuments((prev) =>
        prev.map((d) => (d.id === selectedDoc.id ? updated : d))
      );
      setSelectedDoc(null);
      toast.success("Document resolved");
      await loadDocuments(); // Refresh queue
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to resolve";
      toast.error(message);
    }
  }, [
    selectedDoc,
    finalCategory,
    applicantName,
    applicantLastname,
    comment,
    loadDocuments,
  ]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only handle shortcuts if not typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (!selectedDoc) return;

      switch (e.key.toLowerCase()) {
        case "c": { // Claim
          if (selectedDoc.status === "queued") {
            handleClaim(selectedDoc);
          }
          break;
        }
        case "r": { // Release
          if (
            selectedDoc.status === "in_review" &&
            selectedDoc.assigned_reviewer_id === user?.id
          ) {
            handleRelease(selectedDoc);
          }
          break;
        }
        case "a": { // Accept (same category)
          if (
            selectedDoc.status === "in_review" &&
            selectedDoc.assigned_reviewer_id === user?.id
          ) {
            setFinalCategory(selectedDoc.category_predicted);
            setTimeout(() => handleResolve(), 100);
          }
          break;
        }
        case "escape": { // Close detail
          setSelectedDoc(null);
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [selectedDoc, user, handleClaim, handleRelease, handleResolve]);

  // Filter documents by search
  const filteredDocs = documents.filter((doc) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      doc.applicant_name.toLowerCase().includes(term) ||
      doc.applicant_lastname.toLowerCase().includes(term) ||
      doc.original_name.toLowerCase().includes(term)
    );
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued": {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
            <Clock className="h-3 w-3" />
            Queued
          </span>
        );
      }
      case "in_review": {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
            <FileText className="h-3 w-3" />
            In Review
          </span>
        );
      }
      case "resolved": {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" />
            Resolved
          </span>
        );
      }
      default: {
        return (
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            {status}
          </span>
        );
      }
    }
  };

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 0.8) {
      return (
        <span className="text-green-600 dark:text-green-400 font-medium">
          {(confidence * 100).toFixed(0)}%
        </span>
      );
    }
    if (confidence >= 0.6) {
      return (
        <span className="text-yellow-600 dark:text-yellow-400 font-medium">
          {(confidence * 100).toFixed(0)}%
        </span>
      );
    }
    return (
      <span className="text-red-600 dark:text-red-400 font-medium">
        {(confidence * 100).toFixed(0)}%
      </span>
    );
  };

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card shadow-sm sticky top-0 z-10">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <h1 className="text-xl font-semibold">Review Queue</h1>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {user.email} ({user.role})
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate({ to: "/" })}
              >
                Back to Upload
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Queue List */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Documents ({filteredDocs.length})</CardTitle>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={loadDocuments}
                    disabled={isLoading}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Filters */}
                <div className="space-y-2">
                  <Label htmlFor="search">Search</Label>
                  <Input
                    id="search"
                    placeholder="Name or filename..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    variant={filter === "queued" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("queued")}
                  >
                    Queued
                  </Button>
                  <Button
                    variant={filter === "in_review" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("in_review")}
                  >
                    In Review
                  </Button>
                  <Button
                    variant={filter === "all" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("all")}
                  >
                    All
                  </Button>
                </div>

                {/* Document list */}
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {filteredDocs.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => setSelectedDoc(doc)}
                      type="button"
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        selectedDoc?.id === doc.id
                          ? "bg-primary/10 border-primary"
                          : "bg-card border-border hover:bg-accent"
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">
                            {doc.applicant_name} {doc.applicant_lastname}
                          </span>
                          {getStatusBadge(doc.status)}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {doc.original_name}
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            {categoryNames[doc.category_predicted] ||
                              doc.category_predicted}
                          </span>
                          {getConfidenceBadge(doc.category_confidence)}
                        </div>
                      </div>
                    </button>
                  ))}

                  {filteredDocs.length === 0 && !isLoading && (
                    <div className="text-center py-8 text-muted-foreground">
                      <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No documents found</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Detail Panel */}
          <div className="lg:col-span-2">
            {selectedDoc ? (
              <Card>
                <CardHeader>
                  <CardTitle>Document Review</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Document info */}
                  <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Status
                      </div>
                      <div className="mt-1">
                        {getStatusBadge(selectedDoc.status)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Confidence
                      </div>
                      <div className="mt-1">
                        {getConfidenceBadge(selectedDoc.category_confidence)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Original Name
                      </div>
                      <div className="mt-1 text-sm font-medium truncate">
                        {selectedDoc.original_name}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Uploaded
                      </div>
                      <div className="mt-1 text-sm">
                        {new Date(selectedDoc.uploaded_at).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Preview */}
                  {isLoadingPreview ? (
                    <div className="flex items-center justify-center h-64 bg-muted rounded-lg">
                      <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : preview?.type === "image" && preview.image ? (
                    <div className="border rounded-lg overflow-hidden">
                      <img
                        src={preview.image}
                        alt="Document preview"
                        className="w-full max-h-96 object-contain bg-muted"
                      />
                    </div>
                  ) : preview?.type === "text" && preview.text ? (
                    <div className="p-4 bg-muted rounded-lg max-h-64 overflow-y-auto">
                      <pre className="text-sm whitespace-pre-wrap">
                        {preview.text}
                      </pre>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-32 bg-muted rounded-lg">
                      <p className="text-muted-foreground">
                        No preview available
                      </p>
                    </div>
                  )}

                  {/* Review form - only for in_review docs assigned to current user */}
                  {selectedDoc.status === "in_review" &&
                    selectedDoc.assigned_reviewer_id === user.id && (
                      <div className="space-y-4 p-4 border rounded-lg">
                        <h3 className="font-medium">Review Document</h3>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="applicant_name">
                              Applicant Name
                            </Label>
                            <Input
                              id="applicant_name"
                              value={applicantName}
                              onChange={(e) => setApplicantName(e.target.value)}
                            />
                          </div>
                          <div>
                            <Label htmlFor="applicant_lastname">
                              Applicant Lastname
                            </Label>
                            <Input
                              id="applicant_lastname"
                              value={applicantLastname}
                              onChange={(e) =>
                                setApplicantLastname(e.target.value)
                              }
                            />
                          </div>
                        </div>

                        <div>
                          <Label htmlFor="final_category">Final Category</Label>
                          <select
                            id="final_category"
                            value={finalCategory}
                            onChange={(e) => setFinalCategory(e.target.value)}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {Object.entries(categoryNames).map(
                              ([key, name]) => (
                                <option key={key} value={key}>
                                  {name}
                                </option>
                              )
                            )}
                          </select>
                        </div>

                        <div>
                          <Label htmlFor="comment">Comment (optional)</Label>
                          <textarea
                            id="comment"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            placeholder="Add any notes..."
                          />
                        </div>

                        <div className="flex gap-2">
                          <Button onClick={handleResolve} className="flex-1">
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Resolve (Enter)
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => handleRelease(selectedDoc)}
                          >
                            <XCircle className="h-4 w-4 mr-2" />
                            Release (R)
                          </Button>
                        </div>

                        <div className="text-xs text-muted-foreground">
                          Shortcuts: A=Accept • R=Release • Esc=Close
                        </div>
                      </div>
                    )}

                  {/* Action buttons for queued docs */}
                  {selectedDoc.status === "queued" && (
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleClaim(selectedDoc)}
                        className="flex-1"
                      >
                        <FileText className="h-4 w-4 mr-2" />
                        Claim Document (C)
                      </Button>
                    </div>
                  )}

                  {/* Info for other statuses */}
                  {selectedDoc.status === "resolved" && (
                    <div className="p-4 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-900/30 rounded-lg">
                      <p className="text-sm text-green-800 dark:text-green-400">
                        This document has been resolved.
                        {selectedDoc.category_final && (
                          <span className="ml-2 font-medium">
                            Final category:{" "}
                            {categoryNames[selectedDoc.category_final] ||
                              selectedDoc.category_final}
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="flex items-center justify-center h-96">
                  <div className="text-center text-muted-foreground">
                    <FileText className="h-16 w-16 mx-auto mb-4 opacity-50" />
                    <p>Select a document to review</p>
                    <p className="text-sm mt-2">
                      Click on a document from the queue
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

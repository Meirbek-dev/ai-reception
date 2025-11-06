import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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

const getInitials = (email?: string) => {
  if (!email) return "?";
  const [local] = email.split("@");
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const source = parts.length ? parts : [local];
  const initials = source
    .slice(0, 2)
    .map((segment) => segment[0])
    .join("");
  return initials.toUpperCase().slice(0, 2) || "?";
};

function ReviewQueuePage() {
  const {
    user,
    session,
    isAuthenticated,
    isLoading: authLoading,
    isRefreshing,
    refresh,
  } = useAuth();
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

  const sessionExpiryLabel = useMemo(() => {
    if (!session) return "";
    const expiresAtDate = new Date(session.expires_at);
    if (Number.isNaN(expiresAtDate.getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(expiresAtDate);
  }, [session]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !isRefreshing && !isAuthenticated) {
      navigate({ to: "/login" });
    }
  }, [authLoading, isAuthenticated, isRefreshing, navigate]);

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
        error instanceof Error ? error.message : "Не удалось загрузить очередь";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (!authLoading && !isRefreshing && isAuthenticated) {
      loadDocuments();
    }
  }, [authLoading, isAuthenticated, isRefreshing, loadDocuments]);

  // Load preview when document selected
  useEffect(() => {
    if (selectedDoc) {
      setIsLoadingPreview(true);
      reviewApi
        .getDocumentPreview(selectedDoc.id)
        .then(setPreview)
        .catch((error) => {
          console.error("Не удалось загрузить предпросмотр:", error);
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
      toast.success("Документ принят");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось принять документ";
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
        toast.success("Документ возвращён в очередь");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Не удалось вернуть документ в очередь";
        toast.error(message);
      }
    },
    [selectedDoc]
  );

  // Resolve document
  const handleResolve = useCallback(async () => {
    if (!selectedDoc) return;

    if (!finalCategory) {
      toast.error("Пожалуйста, выберите категорию");
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
      toast.success("Проверка завершена");
      await loadDocuments(); // Refresh queue
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось завершить проверку документа";
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

  const handleRefreshSession = useCallback(async () => {
    const success = await refresh();
    if (success) {
      toast.success("Сессия обновлена");
    } else {
      toast.error("Сессия истекла, пожалуйста войдите снова");
    }
  }, [refresh]);

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
        case "c": {
          // Claim
          if (selectedDoc.status === "queued") {
            handleClaim(selectedDoc);
          }
          break;
        }
        case "r": {
          // Release
          if (
            selectedDoc.status === "in_review" &&
            selectedDoc.assigned_reviewer_id?.toString() === user?.id
          ) {
            handleRelease(selectedDoc);
          }
          break;
        }
        case "a": {
          // Accept (same category)
          if (
            selectedDoc.status === "in_review" &&
            selectedDoc.assigned_reviewer_id?.toString() === user?.id
          ) {
            setFinalCategory(selectedDoc.category_predicted);
            setTimeout(() => handleResolve(), 100);
          }
          break;
        }
        case "escape": {
          // Close detail
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
            В очереди
          </span>
        );
      }
      case "in_review": {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
            <FileText className="h-3 w-3" />
            На рассмотрении
          </span>
        );
      }
      case "resolved": {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" />
            Завершено
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

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <RefreshCw className="h-8 w-8 animate-spin" />
          <p className="text-sm">Проверяем сессию...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  if (!user) {
    return null;
  }

  const canReview = user.role === "reviewer" || user.role === "admin";

  if (!canReview) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card shadow-sm">
          <div className="mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">
              <h1 className="text-xl font-semibold">Очередь на проверку</h1>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate({ to: "/" })}
              >
                Назад к загрузке
              </Button>
            </div>
          </div>
        </header>
        <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-12">
          <Card>
            <CardContent className="py-10 text-center space-y-3">
              <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
              <h2 className="text-lg font-semibold">Нет доступа</h2>
              <p className="text-sm text-muted-foreground">
                Эта страница доступна только рецензентам. Обратитесь к
                администратору за правами доступа.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card shadow-sm sticky top-0 z-10">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <h1 className="text-xl font-semibold">Очередь на проверку</h1>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-3">
                <Avatar className="size-9">
                  <AvatarFallback className="text-xs font-semibold uppercase">
                    {getInitials(user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="leading-tight">
                  <div className="text-sm font-medium text-foreground">
                    {user.email}
                  </div>
                  <div className="text-xs uppercase text-muted-foreground">
                    {user.role}
                  </div>
                  {sessionExpiryLabel && (
                    <div className="text-[11px] text-muted-foreground">
                      Сессия до {sessionExpiryLabel}
                    </div>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefreshSession}
                disabled={isRefreshing}
                title="Обновить сессию"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
                />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate({ to: "/" })}
              >
                Назад к загрузке
              </Button>
            </div>
          </div>
        </div>
      </header>

      {isRefreshing && (
        <div className="bg-muted/70 border-b border-border">
          <div className="mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Продлеваем вашу сессию...</span>
          </div>
        </div>
      )}

      <div className="mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Queue List */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Документы ({filteredDocs.length})</CardTitle>
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
                  <Label htmlFor="search">Поиск</Label>
                  <Input
                    id="search"
                    placeholder="Имя или имя файла..."
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
                    В очереди
                  </Button>
                  <Button
                    variant={filter === "in_review" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("in_review")}
                  >
                    На рассмотрении
                  </Button>
                  <Button
                    variant={filter === "all" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter("all")}
                  >
                    Все
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
                      <p>Документы не найдены</p>
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
                  <CardTitle>Проверка документа</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Document info */}
                  <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Статус
                      </div>
                      <div className="mt-1">
                        {getStatusBadge(selectedDoc.status)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Уверенность
                      </div>
                      <div className="mt-1">
                        {getConfidenceBadge(selectedDoc.category_confidence)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Исходное имя
                      </div>
                      <div className="mt-1 text-sm font-medium truncate">
                        {selectedDoc.original_name}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground">
                        Загружено
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
                        alt="Предпросмотр документа"
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
                        Предпросмотр недоступен
                      </p>
                    </div>
                  )}

                  {/* Review form - only for in_review docs assigned to current user */}
                  {selectedDoc.status === "in_review" &&
                    selectedDoc.assigned_reviewer_id?.toString() === user.id && (
                      <div className="space-y-4 p-4 border rounded-lg">
                        <h3 className="font-medium">Проверить документ</h3>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="applicant_name">
                              Имя заявителя
                            </Label>
                            <Input
                              id="applicant_name"
                              value={applicantName}
                              onChange={(e) => setApplicantName(e.target.value)}
                            />
                          </div>
                          <div>
                            <Label htmlFor="applicant_lastname">
                              Фамилия заявителя
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
                          <Label htmlFor="final_category">
                            Итоговая категория
                          </Label>
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
                          <Label htmlFor="comment">
                            Комментарий (необязательно)
                          </Label>
                          <textarea
                            id="comment"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            placeholder="Добавьте заметки..."
                          />
                        </div>

                        <div className="flex gap-2">
                          <Button onClick={handleResolve} className="flex-1">
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Завершить (Enter)
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => handleRelease(selectedDoc)}
                          >
                            <XCircle className="h-4 w-4 mr-2" />
                            Вернуть (R)
                          </Button>
                        </div>

                        <div className="text-xs text-muted-foreground">
                          Соч. клавиши: A=Принять • R=Вернуть • Esc=Закрыть
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
                        Принять документ (C)
                      </Button>
                    </div>
                  )}

                  {/* Info for other statuses */}
                  {selectedDoc.status === "resolved" && (
                    <div className="p-4 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-900/30 rounded-lg">
                      <p className="text-sm text-green-800 dark:text-green-400">
                        Этот документ был обработан.
                        {selectedDoc.category_final && (
                          <span className="ml-2 font-medium">
                            Итоговая категория:{" "}
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
                    <p>Выберите документ для проверки</p>
                    <p className="text-sm mt-2">
                      Нажмите на документ в очереди
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

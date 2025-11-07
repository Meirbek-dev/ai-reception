import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Navbar } from "@/components/Navbar";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  RefreshCw,
  XCircle,
  Download,
  User,
  Calendar,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import * as reviewApi from "@/lib/review";
import type { Document } from "@/lib/review";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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

const THEME_KEY = "ai_reception_theme";

function ReviewQueuePage() {
  const {
    user,
    isAuthenticated,
    isLoading: authLoading,
    isRefreshing,
    refresh,
    logout,
  } = useAuth();
  const navigate = useNavigate();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "queued" | "in_review">(
    "queued"
  );
  const [searchTerm, setSearchTerm] = useState("");

  // Theme state
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark") return true;
      if (saved === "light") return false;
      if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch {
      // ignore
    }
    return false;
  });

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
  const [isResolving, setIsResolving] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);

  // Apply theme
  useEffect(() => {
    try {
      document.documentElement.classList.toggle("dark", isDark);
      localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    } catch {
      // ignore
    }
  }, [isDark]);

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
        .then((previewData) => {
          console.log("Preview loaded:", previewData);
          setPreview(previewData);
        })
        .catch((error) => {
          console.error("Не удалось загрузить предпросмотр:", error);
          const message = error instanceof Error ? error.message : "Unknown error";
          toast.error(`Ошибка загрузки предпросмотра: ${message}`);
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
    setIsClaiming(true);
    try {
      const updated = await reviewApi.claimDocument(doc.id);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? updated : d)));
      setSelectedDoc(updated);
      toast.success("Документ принят на проверку");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось принять документ";
      toast.error(message);
    } finally {
      setIsClaiming(false);
    }
  }, []);

  // Release document
  const handleRelease = useCallback(
    async (doc: Document) => {
      setIsReleasing(true);
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
          error instanceof Error
            ? error.message
            : "Не удалось вернуть документ в очередь";
        toast.error(message);
      } finally {
        setIsReleasing(false);
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

    if (!applicantName.trim() || !applicantLastname.trim()) {
      toast.error("Пожалуйста, заполните имя и фамилию");
      return;
    }

    setIsResolving(true);
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
      toast.success("Проверка успешно завершена!");
      await loadDocuments(); // Refresh queue
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Не удалось завершить проверку документа";
      toast.error(message);
    } finally {
      setIsResolving(false);
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

  const toggleDark = useCallback(() => setIsDark((v) => !v), []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      toast.success("Вы вышли из системы");
      navigate({ to: "/login" });
    } catch {
      toast.error("Ошибка при выходе");
    }
  }, [logout, navigate]);

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
          <Badge variant="warning">
            <Clock className="h-3 w-3" />
            В очереди
          </Badge>
        );
      }
      case "in_review": {
        return (
          <Badge variant="info">
            <FileText className="h-3 w-3" />
            На рассмотрении
          </Badge>
        );
      }
      case "resolved": {
        return (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" />
            Завершено
          </Badge>
        );
      }
      default: {
        return <Badge variant="outline">{status}</Badge>;
      }
    }
  };

  const getConfidenceBadge = (confidence: number) => {
    const percentage = (confidence * 100).toFixed(0);
    if (confidence >= 0.8) {
      return (
        <Badge variant="success" className="gap-1">
          <TrendingUp className="h-3 w-3" />
          {percentage}%
        </Badge>
      );
    }
    if (confidence >= 0.6) {
      return (
        <Badge variant="warning" className="gap-1">
          <TrendingUp className="h-3 w-3" />
          {percentage}%
        </Badge>
      );
    }
    return (
      <Badge variant="destructive" className="gap-1">
        <TrendingUp className="h-3 w-3" />
        {percentage}%
      </Badge>
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
      <Navbar
        isDark={isDark}
        toggleDark={toggleDark}
        user={user}
        onLogout={handleLogout}
        isRefreshing={isRefreshing}
        onRefreshSession={handleRefreshSession}
        currentPage="review"
      />

      <div className="mx-auto min-h-[calc(100vh-4rem)] px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Queue List */}
          <div className="flex h-full flex-col gap-4 lg:col-span-1">
            {/* Statistics Summary */}
            <div className="grid grid-cols-3 gap-2">
              <Card className="p-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                    {documents.filter((d) => d.status === "queued").length}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    В очереди
                  </div>
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                    {documents.filter((d) => d.status === "in_review").length}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    На проверке
                  </div>
                </div>
              </Card>
              <Card className="p-3">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                    {documents.filter((d) => d.status === "resolved").length}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Завершено
                  </div>
                </div>
              </Card>
            </div>

            <Card className="flex flex-1 flex-col overflow-hidden">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Документы ({filteredDocs.length})</CardTitle>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={loadDocuments}
                    disabled={isLoading}
                    aria-label="Обновить список"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4 overflow-hidden">
                {/* Filters */}
                <div className="space-y-2">
                  <Label htmlFor="search">Поиск</Label>
                  <Input
                    id="search"
                    placeholder="Имя абитуриента или название файла..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">
                    Фильтр по статусу
                  </Label>
                  <div className="flex gap-2">
                    <Button
                      variant={filter === "queued" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFilter("queued")}
                      className="flex-1 transition-all"
                    >
                      <Clock className="h-3.5 w-3.5 mr-1.5" />
                      В очереди
                    </Button>
                    <Button
                      variant={filter === "in_review" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFilter("in_review")}
                      className="flex-1 transition-all"
                    >
                      <FileText className="h-3.5 w-3.5 mr-1.5" />
                      На проверке
                    </Button>
                    <Button
                      variant={filter === "all" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setFilter("all")}
                      className="flex-1 transition-all"
                    >
                      Все
                    </Button>
                  </div>
                </div>

                {/* Document list */}
                <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                  {isLoading ? (
                    // Loading skeleton
                    Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-lg border border-border bg-card animate-pulse"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="h-4 bg-muted rounded w-32" />
                            <div className="h-5 bg-muted rounded-full w-20" />
                          </div>
                          <div className="h-3 bg-muted rounded w-full" />
                          <div className="flex items-center justify-between">
                            <div className="h-3 bg-muted rounded w-24" />
                            <div className="h-5 bg-muted rounded-full w-12" />
                          </div>
                        </div>
                      </div>
                    ))
                  ) : filteredDocs.length > 0 ? (
                    filteredDocs.map((doc) => (
                      <button
                        key={doc.id}
                        onClick={() => setSelectedDoc(doc)}
                        type="button"
                        className={`w-full text-left p-3 rounded-lg border transition-all duration-200 ${
                          selectedDoc?.id === doc.id
                            ? "bg-primary/10 border-primary shadow-md ring-2 ring-primary/20"
                            : "bg-card border-border hover:bg-accent hover:shadow-sm"
                        }`}
                        aria-label={`Выбрать документ ${doc.applicant_name} ${doc.applicant_lastname}`}
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm truncate flex items-center gap-1.5">
                              <User className="h-3.5 w-3.5 text-muted-foreground" />
                              {doc.applicant_name} {doc.applicant_lastname}
                            </span>
                            {getStatusBadge(doc.status)}
                          </div>
                          <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                            <FileText className="h-3 w-3" />
                            {doc.original_name}
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground font-medium">
                              {categoryNames[doc.category_predicted] ||
                                doc.category_predicted}
                            </span>
                            {getConfidenceBadge(doc.category_confidence)}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(doc.uploaded_at).toLocaleDateString(
                              "ru-RU",
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      <AlertCircle className="h-12 w-12 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">Документы не найдены</p>
                      <p className="text-xs mt-1">
                        Попробуйте изменить фильтры или поиск
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Detail Panel */}
          <div className="flex h-full flex-col lg:col-span-2">
            {selectedDoc ? (
              <Card className="flex h-full flex-col overflow-hidden">
                <CardHeader className="pt-4">
                  <CardTitle>Проверка документа</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 space-y-6 overflow-y-auto pr-1">
                  {/* Document info */}
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-4 p-4 bg-linear-to-br from-muted/50 to-muted/30 rounded-lg border border-border/50">
                      <div className="space-y-3 flex-1">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="text-xs text-muted-foreground">
                              Заявитель
                            </div>
                            <div className="font-semibold">
                              {selectedDoc.applicant_name}{" "}
                              {selectedDoc.applicant_lastname}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-muted-foreground">
                              Исходное имя файла
                            </div>
                            <div className="text-sm font-medium truncate">
                              {selectedDoc.original_name}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2 text-right">
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            Статус
                          </div>
                          {getStatusBadge(selectedDoc.status)}
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">
                            Уверенность AI
                          </div>
                          {getConfidenceBadge(selectedDoc.category_confidence)}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Загружено
                          </div>
                          <div className="font-medium">
                            {new Date(selectedDoc.uploaded_at).toLocaleString(
                              "ru-RU",
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg">
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Категория AI
                          </div>
                          <div className="font-medium">
                            {categoryNames[selectedDoc.category_predicted] ||
                              selectedDoc.category_predicted}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="border-t border-border" />

                  {/* Preview */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Предпросмотр документа
                      </h3>
                      {preview?.image && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (preview?.image) {
                              const link = document.createElement("a");
                              link.href = preview.image;
                              link.download = selectedDoc.original_name;
                              link.click();
                            }
                          }}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          Скачать
                        </Button>
                      )}
                    </div>
                    {isLoadingPreview ? (
                      <div className="flex flex-col items-center justify-center h-64 bg-muted/50 rounded-lg border-2 border-dashed border-border">
                        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
                        <p className="text-sm text-muted-foreground">
                          Загрузка предпросмотра...
                        </p>
                      </div>
                    ) : preview?.type === "image" && preview.image ? (
                      <div className="border-2 rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-shadow">
                        <img
                          src={preview.image}
                          alt="Предпросмотр документа"
                          className="w-full max-h-96 object-contain bg-muted/50"
                        />
                      </div>
                    ) : preview?.type === "text" && preview.text ? (
                      <div className="p-4 bg-muted/50 rounded-lg border max-h-64 overflow-y-auto">
                        <pre className="text-sm whitespace-pre-wrap font-mono">
                          {preview.text}
                        </pre>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-32 bg-muted/50 rounded-lg border-2 border-dashed border-border">
                        <AlertCircle className="h-8 w-8 text-muted-foreground/50 mb-2" />
                        <p className="text-sm text-muted-foreground">
                          Предпросмотр недоступен
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Divider */}
                  {selectedDoc.status === "in_review" &&
                    selectedDoc.assigned_reviewer_id?.toString() ===
                      user.id && <div className="border-t border-border" />}

                  {/* Review form - only for in_review docs assigned to current user */}
                  {selectedDoc.status === "in_review" &&
                    selectedDoc.assigned_reviewer_id?.toString() ===
                      user.id && (
                      <div className="space-y-5 p-5 border-2 rounded-lg bg-card shadow-sm">
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-lg flex items-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-primary" />
                            Форма проверки
                          </h3>
                          <Badge variant="info">На проверке</Badge>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label
                              htmlFor="applicant_name"
                              className="flex items-center gap-1.5"
                            >
                              <User className="h-3.5 w-3.5" />
                              Имя заявителя
                            </Label>
                            <Input
                              id="applicant_name"
                              value={applicantName}
                              onChange={(e) => setApplicantName(e.target.value)}
                              placeholder="Введите имя"
                              className="transition-all focus:ring-2"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label
                              htmlFor="applicant_lastname"
                              className="flex items-center gap-1.5"
                            >
                              <User className="h-3.5 w-3.5" />
                              Фамилия заявителя
                            </Label>
                            <Input
                              id="applicant_lastname"
                              value={applicantLastname}
                              onChange={(e) =>
                                setApplicantLastname(e.target.value)
                              }
                              placeholder="Введите фамилию"
                              className="transition-all focus:ring-2"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label
                            htmlFor="final_category"
                            className="flex items-center gap-1.5"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            Итоговая категория{" "}
                            <span className="text-destructive">*</span>
                          </Label>
                          <Select
                            value={finalCategory}
                            onValueChange={(v) => setFinalCategory(v)}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(categoryNames).map(([key, name]) => (
                                <SelectItem key={key} value={key}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {finalCategory !==
                            selectedDoc.category_predicted && (
                            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                              <AlertCircle className="h-3 w-3" />
                              Категория изменена с предсказания AI
                            </p>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="comment" className="flex items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5" />
                            Комментарий{" "}
                            <span className="text-muted-foreground text-xs">
                              (необязательно)
                            </span>
                          </Label>
                          <Textarea
                            id="comment"
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            className="min-h-24"
                            placeholder="Добавьте комментарии или заметки о документе..."
                          />
                        </div>

                        <div className="pt-2 border-t space-y-3">
                          <div className="flex gap-2">
                            <Button
                              onClick={handleResolve}
                              className="flex-1 h-11"
                              disabled={
                                !finalCategory ||
                                !applicantName.trim() ||
                                !applicantLastname.trim() ||
                                isResolving
                              }
                            >
                              {isResolving ? (
                                <>
                                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                                  Сохранение...
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="h-4 w-4 mr-2" />
                                  Завершить проверку
                                </>
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => handleRelease(selectedDoc)}
                              className="h-11"
                              disabled={isReleasing || isResolving}
                            >
                              {isReleasing ? (
                                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <XCircle className="h-4 w-4 mr-2" />
                              )}
                              Вернуть
                            </Button>
                          </div>

                          <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground bg-muted/50 p-2.5 rounded-md">
                            <span className="flex items-center gap-1">
                              <kbd className="px-1.5 py-0.5 text-[10px] font-semibold bg-background border rounded">
                                A
                              </kbd>
                              Принять
                            </span>
                            <span className="flex items-center gap-1">
                              <kbd className="px-1.5 py-0.5 text-[10px] font-semibold bg-background border rounded">
                                R
                              </kbd>
                              Вернуть
                            </span>
                            <span className="flex items-center gap-1">
                              <kbd className="px-1.5 py-0.5 text-[10px] font-semibold bg-background border rounded">
                                Esc
                              </kbd>
                              Закрыть
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                  {/* Action buttons for queued docs */}
                  {selectedDoc.status === "queued" && (
                    <div className="space-y-3 p-5 border-2 border-dashed rounded-lg bg-yellow-50/50 dark:bg-yellow-900/10">
                      <div className="flex items-center gap-2 text-yellow-800 dark:text-yellow-400">
                        <Clock className="h-5 w-5" />
                        <span className="font-semibold">
                          Документ ожидает проверки
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Примите документ на проверку, чтобы начать работу с ним
                      </p>
                      <Button
                        onClick={() => handleClaim(selectedDoc)}
                        className="w-full h-11"
                        size="lg"
                        disabled={isClaiming}
                      >
                        {isClaiming ? (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                            Принятие...
                          </>
                        ) : (
                          <>
                            <FileText className="h-4 w-4 mr-2" />
                            Принять на проверку
                            <kbd className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold bg-primary-foreground/20 border border-primary-foreground/30 rounded">
                              C
                            </kbd>
                          </>
                        )}
                      </Button>
                    </div>
                  )}

                  {/* Info for resolved status */}
                  {selectedDoc.status === "resolved" && (
                    <div className="space-y-3 p-5 border-2 rounded-lg bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-900/30">
                      <div className="flex items-center gap-2 text-green-800 dark:text-green-400">
                        <CheckCircle2 className="h-5 w-5" />
                        <span className="font-semibold">
                          Документ обработан
                        </span>
                      </div>
                      {selectedDoc.category_final && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between p-3 bg-background/50 rounded-md">
                            <span className="text-sm text-muted-foreground">
                              Итоговая категория:
                            </span>
                            <Badge variant="success">
                              {categoryNames[selectedDoc.category_final] ||
                                selectedDoc.category_final}
                            </Badge>
                          </div>
                          {selectedDoc.category_final !==
                            selectedDoc.category_predicted && (
                            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                              <AlertCircle className="h-3 w-3" />
                              Категория была изменена рецензентом
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="flex h-full flex-col overflow-hidden">
                <CardContent className="flex flex-1 items-center justify-center">
                  <div className="text-center text-muted-foreground max-w-md">
                    <div className="relative mb-6">
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-32 h-32 bg-primary/5 rounded-full animate-pulse" />
                      </div>
                      <FileText className="h-20 w-20 mx-auto relative opacity-40" />
                    </div>
                    <h3 className="text-lg font-semibold text-foreground mb-2">
                      Выберите документ для проверки
                    </h3>
                    <p className="text-sm mb-4">
                      Нажмите на документ в списке слева, чтобы начать проверку
                    </p>
                    <div className="flex flex-col gap-2 text-xs bg-muted/50 p-4 rounded-lg">
                      <div className="flex items-center gap-2">
                        <Badge variant="warning" className="text-[10px]">
                          В очереди
                        </Badge>
                        <span>Документы, ожидающие проверки</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="info" className="text-[10px]">
                          На рассмотрении
                        </Badge>
                        <span>Документы, принятые на проверку</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="success" className="text-[10px]">
                          Завершено
                        </Badge>
                        <span>Обработанные документы</span>
                      </div>
                    </div>
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

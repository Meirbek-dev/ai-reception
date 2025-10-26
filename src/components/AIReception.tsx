import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  CloudUpload,
  FileUp,
  FolderOpen,
  Download,
  Trash2,
  User,
  CreditCard,
  GraduationCap,
  ClipboardList,
  Tag,
  HelpCircle,
  Syringe,
  Heart,
  FileText,
  ImageIcon,
  File,
  Sun,
  Moon,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Types
interface UploadedFile {
  id?: string | null;
  uid: string;
  originalName: string;
  // Stored filename on disk (may be null when not stored)
  newName?: string | null;
  category: string;
  // Optional metadata
  size?: number | null;
  modified?: number | null;
  status?: string | null;
}

interface CategoryInfo {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

// Strings for i18n
const strings = {
  appTitle: "AI Reception",
  appHeader: "Информация об абитуриенте",
  nameLabel: "Имя",
  lastNameLabel: "Фамилия",
  uploadBtn: "Загрузить документы",
  uploading: "Обработка файлов...",
  uploadSuccess: "Документы успешно обработаны и классифицированы",
  uploadFail: "Ошибка при загрузке файлов. Попробуйте снова.",
  noFiles: "Нет загруженных документов",
};

// Backend origin helper
// In development we always point to the API running on localhost:5040.
// In production we use the current origin (static files served by backend).
const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

// Category configurations
const categoryInfo: Record<string, CategoryInfo> = {
  Udostoverenie: {
    name: "Удостоверение",
    icon: CreditCard,
    color: "rgb(59, 130, 246)",
  },
  Diplom: {
    name: "Диплом/Аттестат",
    icon: GraduationCap,
    color: "rgb(168, 85, 247)",
  },
  ENT: {
    name: "ЕНТ",
    icon: ClipboardList,
    color: "rgb(249, 115, 22)",
  },
  Lgota: {
    name: "Льгота",
    icon: Tag,
    color: "rgb(34, 197, 94)",
  },
  Unclassified: {
    name: "Неизвестно",
    icon: HelpCircle,
    color: "rgb(156, 163, 175)",
  },
  Privivka: {
    name: "Прививочный паспорт",
    icon: Syringe,
    color: "rgb(20, 184, 166)",
  },
  MedSpravka: {
    name: "Медицинская справка",
    icon: Heart,
    color: "rgb(239, 68, 68)",
  },
};

const getFileIcon = (filename?: string) => {
  if (!filename) return File;
  const ext = String(filename).toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "pdf":
      return FileText;
    case "jpg":
    case "jpeg":
    case "png":
      return ImageIcon;
    default:
      return File;
  }
};

// Normalize category keys coming from backend to frontend canonical keys
const CATEGORY_KEY_MAP: Record<string, string> = {
  udostoverenie: "Udostoverenie",
  diplom: "Diplom",
  ent: "ENT",
  lgota: "Lgota",
  unclassified: "Unclassified",
  privivka: "Privivka",
  medspravka: "MedSpravka",
};

// Tolerant normalization: strip non-alphanumerics and map to known keys,
// otherwise fall back to Unclassified.
const normalizeCategoryKey = (raw?: string | null): string => {
  if (!raw) return "Unclassified";
  const simple = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return CATEGORY_KEY_MAP[simple] || "Unclassified";
};

// Main App Component
export default function AIReceptionApp() {
  const THEME_KEY = "ai_reception_theme";

  // Initialize isDark synchronously from localStorage or system preference
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark") return true;
      if (saved === "light") return false;
      if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch (e) {
      // ignore
    }
    return false;
  });
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [overlayReject, setOverlayReject] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<UploadedFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Apply theme class and persist selection
  useEffect(() => {
    try {
      if (isDark) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    } catch (e) {
      // ignore
    }
  }, [isDark]);

  const isFormValid = useCallback(() => {
    const trimmedName = name.trim();
    const trimmedLast = lastName.trim();
    if (trimmedName.length < 2 || trimmedLast.length < 2) return false;
    const noDigits = /^[^0-9]+$/;
    return noDigits.test(trimmedName) && noDigits.test(trimmedLast);
  }, [name, lastName]);

  const validateFiles = (fileList: FileList | File[]) => {
    const allowed = new Set(["pdf", "jpg", "jpeg", "png"]);
    const filesArray = Array.from(fileList);
    const invalid = filesArray.filter((f) => {
      const ext = f.name.toLowerCase().split(".").pop() || "";
      return !allowed.has(ext);
    });
    return { valid: invalid.length === 0, invalid };
  };

  const uploadFiles = async (fileList: File[]) => {
    if (isLoading) return;

    setIsLoading(true);

    const formData = new FormData();
    fileList.forEach((file) => formData.append("files", file));
    formData.append("name", name);
    formData.append("lastname", lastName);

    try {
      const uploadUrl = `${getBackendOrigin()}/upload`;
      const response = await fetch(uploadUrl, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error("Upload failed, status:", response.status, text);
        // small UX hint: briefly show overlayReject to indicate failure
        setOverlayReject(true);
        setTimeout(() => setOverlayReject(false), 1200);
        return;
      }

      // Parse upload response (contains processed entries including unclassified)
      const uploadResult = await response.json().catch(() => []);

      // Also fetch persisted files from the server so we show both saved and
      // just-processed (but not saved) files. Merge by uid to avoid dups.
      const filesUrl = `${getBackendOrigin()}/files`;
      const filesResponse = await fetch(filesUrl).catch(() => null);
      let persisted: UploadedFile[] = [];
      if (filesResponse && filesResponse.ok) {
        persisted = (await filesResponse.json()) as UploadedFile[];
      }

      const merged: UploadedFile[] = [
        // uploadResult first so recently processed (including unclassified)
        // are visible immediately
        ...(Array.isArray(uploadResult) ? uploadResult : []),
        // then persisted ones that don't duplicate the same uid
        ...persisted.filter(
          (p) =>
            !Array.isArray(uploadResult) ||
            !(uploadResult as UploadedFile[]).some((u) => u.uid === p.uid)
        ),
      ];

      setFiles(merged as UploadedFile[]);
    } catch (error) {
      console.error("Upload failed:", error);
      setOverlayReject(true);
      setTimeout(() => setOverlayReject(false), 1200);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = () => {
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const { valid } = validateFiles(droppedFiles);

    if (!valid) {
      setOverlayReject(true);
      setTimeout(() => setOverlayReject(false), 1000);
      return;
    }

    if (isFormValid()) {
      uploadFiles(droppedFiles);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const selectedFiles = Array.from(e.target.files);
    const { valid } = validateFiles(selectedFiles);

    if (!valid) {
      setOverlayReject(true);
      setTimeout(() => setOverlayReject(false), 900);
      return;
    }

    uploadFiles(selectedFiles);
  };

  const pickFiles = () => {
    if (!isFormValid() || isLoading) return;
    fileInputRef.current?.click();
  };

  const deleteFile = async (file: UploadedFile) => {
    if (!file.id) {
      setFiles((prev) => prev.filter((f) => f !== file));
      return;
    }

    try {
      const url = `${getBackendOrigin()}/files/${encodeURIComponent(file.id)}`;
      const response = await fetch(url, { method: "DELETE" });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error("Delete failed, status:", response.status, text);
        return;
      }

      const filesUrl = `${getBackendOrigin()}/files`;
      const filesResponse = await fetch(filesUrl);
      if (!filesResponse.ok) {
        console.error(
          "Failed to fetch files list after delete",
          filesResponse.status
        );
        return;
      }

      const filesData = await filesResponse.json();
      setFiles(filesData as UploadedFile[]);
    } catch (error) {
      console.error("Delete failed:", error);
    }
  };

  const downloadFile = (file: UploadedFile) => {
    if (!file.id) return;
    const url = `${getBackendOrigin()}/files/${encodeURIComponent(file.id)}`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.download = file.newName || file.originalName;
    // Some browsers require the anchor to be in DOM
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadAll = () => {
    const url = `${getBackendOrigin()}/download_zip?name=${encodeURIComponent(
      name
    )}&lastname=${encodeURIComponent(lastName)}`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.download = "documents.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const toggleSelection = (uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allUids = files.map((f) => f.uid);
    if (selected.size === files.length && files.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allUids));
    }
  };

  const deleteSelected = async () => {
    const filesToDelete = files.filter((f) => selected.has(f.uid));
    for (const file of filesToDelete) {
      await deleteFile(file);
    }
    setSelected(new Set());
  };

  const reset = () => {
    setName("");
    setLastName("");
    setFiles([]);
    setSelected(new Set());
  };

  const groupedFiles = files.reduce((acc, file) => {
    // Normalize category using helper to map backend variations to canonical keys
    const categoryKey = normalizeCategoryKey(file.category);

    if (!acc[categoryKey]) {
      acc[categoryKey] = [];
    }
    acc[categoryKey].push(file);
    return acc;
  }, {} as Record<string, UploadedFile[]>);

  return (
    <div
      className="min-h-screen bg-background dark:bg-background transition-colors"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="sticky top-0 z-50 border-b border-border bg-card shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            {/* Left: Logo */}
            <div className="flex items-center">
              <a href="#" aria-label="Home" className="block">
                <img
                  src={isDark ? "/logo_light.png" : "/logo_dark.png"}
                  alt="Logo"
                  className="h-10 w-fit object-contain"
                />
              </a>
            </div>

            {/* Center: App Title */}
            <div className="flex-1 flex items-center justify-center">
              <h1
                className={`text-lg sm:text-xl font-bold ${
                  isDark ? "text-foreground" : "text-tou"
                }`}
              >
                {strings.appTitle}
              </h1>
            </div>

            {/* Right: Theme switcher */}
            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsDark(!isDark)}
                className="rounded-full"
                aria-label="Toggle theme"
              >
                {isDark ? (
                  <Sun className="h-5 w-5" />
                ) : (
                  <Moon className="h-5 w-5 text-tou" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8">
        <Card className="mb-6">
          <CardHeader className="py-4">
            <CardTitle className="flex items-center gap-3 text-foreground">
              <User className="h-6 w-6" />
              {strings.appHeader}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-4">
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">{strings.nameLabel}</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isLoading}
                    placeholder="Введите имя"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{strings.lastNameLabel}</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    disabled={isLoading}
                    placeholder="Введите фамилию"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={pickFiles}
                  disabled={!isFormValid() || isLoading}
                  className="flex-1 min-w-0"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      {strings.uploading}
                    </>
                  ) : (
                    <>
                      <CloudUpload className="mr-2 h-4 w-4" />
                      {strings.uploadBtn}
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={reset}
                  className="flex-none whitespace-nowrap"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Новый абитуриент
                </Button>
              </div>

              {isLoading && <Progress value={undefined} className="w-full" />}
            </div>
          </CardContent>
        </Card>

        <Card
          className="mb-6 cursor-pointer hover:shadow-sm transition-shadow"
          onClick={pickFiles}
        >
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center space-y-4">
              <CloudUpload className="h-12 w-12" />
              <div>
                <p className="text-lg font-medium text-foreground">
                  Перетащите или нажмите, чтобы выбрать файлы
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  Поддерживаемые форматы: PDF, JPG, PNG
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={!isFormValid() || isLoading}
                onClick={(e) => {
                  e.stopPropagation();
                  pickFiles();
                }}
              >
                <FileUp className="mr-2 h-4 w-4" />
                Выбрать файлы
              </Button>
            </div>
          </CardContent>
        </Card>

        {files.length === 0 ? (
          <Card>
            <CardContent className="py-16">
              <div className="flex flex-col items-center justify-center text-center space-y-4">
                <FolderOpen className="h-14 w-14 " />
                <div>
                  <p className="text-lg font-medium text-foreground">
                    {strings.noFiles}
                  </p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Заполните форму и загрузите документы для автоматической
                    классификации.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.size === files.length && files.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="font-semibold text-foreground">
                  Загруженные документы ({files.length})
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={downloadAll}>
                  <Download className="mr-2 h-4 w-4" />
                  Скачать всё
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => {
                    if (selected.size > 0) {
                      setDeleteDialogOpen(true);
                    }
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Удалить
                </Button>
              </div>
            </div>

            {Object.entries(groupedFiles).map(([category, categoryFiles]) => {
              const info = categoryInfo[category] || {
                name: category,
                icon: File,
                color: "rgb(156, 163, 175)",
              };
              const Icon = info.icon;

              return (
                <Card key={category}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-full bg-muted">
                          <Icon className="h-5 w-5 text-foreground" />
                        </div>
                        <span className="font-semibold text-foreground">
                          {info.name} ({categoryFiles.length})
                        </span>
                      </div>
                      {category !== "Unclassified" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            categoryFiles.forEach((f) => {
                              if (f.id) downloadFile(f);
                            });
                          }}
                        >
                          <Download className="h-4 w-4 " />
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {categoryFiles.map((file) => {
                        const FileIcon = getFileIcon(file.originalName);
                        return (
                          <div
                            key={file.uid}
                            className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50"
                          >
                            <div className="p-2 rounded-lg bg-muted">
                              <FileIcon className="h-5 w-5 text-foreground" />
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate text-foreground">
                                {file.originalName}
                              </p>
                              {file.newName && (
                                <p className="text-xs text-muted-foreground">
                                  Сохранено как {file.newName}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={selected.has(file.uid)}
                                onCheckedChange={() =>
                                  toggleSelection(file.uid)
                                }
                              />
                              {category !== "Unclassified" && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => downloadFile(file)}
                                >
                                  <Download className="h-4 w-4 " />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setFileToDelete(file);
                                  setDeleteDialogOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <div className="text-center">
              <Button variant="outline" onClick={reset}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Новый абитуриент
              </Button>
            </div>
          </div>
        )}
      </main>

      {dragActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 pointer-events-none">
          <Card
            className={`p-8 ${overlayReject ? "border-red-500 border-2" : ""}`}
          >
            <div className="flex flex-col items-center space-y-4">
              {overlayReject ? (
                <X className="h-14 w-14 text-destructive" />
              ) : (
                <CloudUpload className="h-14 w-14 " />
              )}
              <div className="text-center">
                <p className="text-lg font-semibold">
                  {overlayReject
                    ? "Неверный формат файла"
                    : "Перетащите файлы, чтобы загрузить"}
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  {overlayReject
                    ? "Поддерживаются: PDF, JPG, PNG"
                    : "Отпустите файлы, чтобы начать загрузку"}
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png"
        onChange={handleFileSelect}
        className="hidden"
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Подтвердите удаление</AlertDialogTitle>
            <AlertDialogDescription>
              {fileToDelete
                ? `Удалить "${fileToDelete.originalName}"?`
                : `Удалить ${selected.size} выбранных файлов?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setFileToDelete(null)}>
              Отмена
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (fileToDelete) {
                  deleteFile(fileToDelete);
                  setFileToDelete(null);
                } else {
                  deleteSelected();
                }
                setDeleteDialogOpen(false);
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

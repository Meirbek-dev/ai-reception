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
import { toast } from "sonner";
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
  type DropzoneHandle,
} from "@/components/kibo-ui/dropzone";

// Types
interface UploadedFile {
  id?: string | null;
  uid: string;
  originalName: string;
  newName?: string | null;
  category: string;
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
  invalidFileType: "Неверный формат файла. Поддерживаются PDF, JPG, PNG.",
  invalidForm: "Пожалуйста, заполните имя и фамилию корректно.",
  noFiles: "Нет загруженных документов",
};

const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

const categoryInfo: Record<string, CategoryInfo> = {
  Udostoverenie: {
    name: "Удостоверение",
    icon: CreditCard,
    color: "rgb(79, 70, 229)",
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
    color: "rgb(107, 114, 128)",
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

const CATEGORY_KEY_MAP: Record<string, string> = {
  udostoverenie: "Udostoverenie",
  diplom: "Diplom",
  ent: "ENT",
  lgota: "Lgota",
  unclassified: "Unclassified",
  privivka: "Privivka",
  medspravka: "MedSpravka",
};

const normalizeCategoryKey = (raw?: string | null): string => {
  if (!raw) return "Unclassified";
  const simple = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return CATEGORY_KEY_MAP[simple] || "Unclassified";
};

export default function AIReceptionApp() {
  const THEME_KEY = "ai_reception_theme";

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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<UploadedFile | null>(null);
  const dropzoneRef = useRef<DropzoneHandle | null>(null);

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
        // show toast on upload failure
        try {
          toast.error(strings.uploadFail);
        } catch (e) {
          /* ignore if toast not available during SSR */
        }
        return;
      }

      const uploadResult = await response.json().catch(() => []);

      const filesUrl = `${getBackendOrigin()}/files`;
      const filesResponse = await fetch(filesUrl).catch(() => null);
      let persisted: UploadedFile[] = [];
      if (filesResponse && filesResponse.ok) {
        persisted = (await filesResponse.json()) as UploadedFile[];
      }

      const merged: UploadedFile[] = [
        ...(Array.isArray(uploadResult) ? uploadResult : []),
        ...persisted.filter(
          (p) =>
            !Array.isArray(uploadResult) ||
            !(uploadResult as UploadedFile[]).some((u) => u.uid === p.uid)
        ),
      ];

      setFiles(merged as UploadedFile[]);
      try {
        toast.success(strings.uploadSuccess);
      } catch (e) {
        /* ignore if toast not available during SSR */
      }
    } catch (error) {
      console.error("Upload failed:", error);
      try {
        toast.error(strings.uploadFail);
      } catch (e) {
        /* ignore if toast not available during SSR */
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = (acceptedFiles: File[], fileRejections: any[]) => {
    if (fileRejections && fileRejections.length > 0) {
      const message = fileRejections?.[0]?.errors?.[0]?.message;
      try {
        toast.error(message || strings.invalidFileType);
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (!isFormValid()) {
      try {
        toast.error(strings.invalidForm);
      } catch (e) {
        /* ignore */
      }
      return;
    }

    uploadFiles(acceptedFiles);
  };

  const pickFiles = () => {
    if (isLoading) return;
    if (!isFormValid()) {
      try {
        toast.error(strings.invalidForm);
      } catch (e) {
        /* ignore */
      }
      return;
    }

    dropzoneRef.current?.open();
  };

  const deleteFile = async (file: UploadedFile) => {
    // If the file has no backend id, or it's classified as Unclassified,
    // just remove it from UI state without calling the backend.
    if (!file.id || normalizeCategoryKey(file.category) === "Unclassified") {
      setFiles((prev) => prev.filter((f) => f !== file));
      return;
    }

    try {
      const url = `${getBackendOrigin()}/files/${encodeURIComponent(file.id)}`;
      const response = await fetch(url, { method: "DELETE" });

      if (!response.ok) {
        // If the file wasn't found on the server, remove it locally to keep UI consistent.
        if (response.status === 404) {
          setFiles((prev) => prev.filter((f) => f !== file));
          return;
        }

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
    const categoryKey = normalizeCategoryKey(file.category);

    if (!acc[categoryKey]) {
      acc[categoryKey] = [];
    }
    acc[categoryKey].push(file);
    return acc;
  }, {} as Record<string, UploadedFile[]>);

  return (
    <div className="min-h-screen bg-background dark:bg-background transition-colors">
      <header className="sticky top-0 z-50 border-b border-border bg-card shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center">
              <a href="#" aria-label="Home" className="block group">
                <img
                  src={isDark ? "/logo_light.png" : "/logo_dark.png"}
                  alt="Logo"
                  className="h-12 w-fit object-contain transition-transform duration-300 group-hover:scale-105"
                />
              </a>
            </div>

            <div className="flex-1 flex items-center justify-center">
              <h1
                className={`text-xl sm:text-2xl font-bold ${
                  isDark ? "text-foreground" : "text-tou"
                }`}
              >
                {strings.appTitle}
              </h1>
            </div>

            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsDark(!isDark)}
                className="rounded-full h-11 w-11 hover:bg-slate-200 dark:hover:bg-slate-800 transition-all duration-300 hover:scale-105"
                aria-label="Toggle theme"
              >
                {isDark ? (
                  <Sun className="h-5 w-5 text-amber-500" />
                ) : (
                  <Moon className="h-5 w-5 text-tou" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <Card className="overflow-hidden">
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
                      <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
                      {strings.uploading}
                    </>
                  ) : (
                    <>
                      <CloudUpload className="mr-2 h-5 w-5" />
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

              {isLoading && (
                <Progress
                  value={undefined}
                  className="w-full h-2 rounded-full"
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Dropzone
          ref={dropzoneRef}
          maxFiles={12}
          onDrop={handleDrop}
          disabled={!isFormValid() || isLoading}
          className="cursor-pointer hover:shadow-2xl transition-all duration-300 border-2 border-dashed overflow-hidden hover:scale-[1.01]"
        >
          <DropzoneEmptyState>
            <CardContent className="py-12">
              <div className="flex flex-col items-center justify-center text-center space-y-4">
                <CloudUpload className="h-14 w-14" />
                <div>
                  <p className="text-xl font-bold text-foreground">
                    Перетащите или нажмите, чтобы выбрать файлы
                  </p>
                  <p className="text-sm text-muted-foreground mt-3 font-medium">
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
                  className="hover:scale-103 transition-all duration-300 shadow-md hover:shadow-lg"
                >
                  <FileUp className="mr-2 h-5 w-5" />
                  Выбрать файлы
                </Button>
              </div>
            </CardContent>
          </DropzoneEmptyState>
          <DropzoneContent />
        </Dropzone>

        {files.length === 0 ? (
          <Card className="overflow-hidden">
            <CardContent className="py-16">
              <div className="flex flex-col items-center justify-center text-center space-y-4">
                <FolderOpen className="h-14 w-14" />
                <div>
                  <p className="text-xl font-bold text-foreground">
                    {strings.noFiles}
                  </p>
                  <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                    Заполните форму и загрузите документы для автоматической
                    классификации.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.size === files.length && files.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
                <span className="font-bold text-lg text-foreground">
                  Загруженные документы ({files.length})
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={downloadAll}
                  className="hover:scale-103 transition-all duration-300"
                >
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
                  className="hover:scale-103 transition-all duration-300 disabled:hover:scale-100"
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
                <Card
                  key={category}
                  className="overflow-hidden shadow-xl hover:shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-3"
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-full bg-muted">
                          <Icon className="h-5 w-5 text-foreground" />
                        </div>
                        <span className="font-semibold text-lg text-foreground">
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
                          className="hover:scale-105 transition-all duration-300"
                        >
                          <Download className="h-5 w-5" />
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {categoryFiles.map((file) => {
                        const FileIcon = getFileIcon(file.originalName);
                        return (
                          <div
                            key={file.uid}
                            className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50"
                          >
                            <div
                              className={`p-2 rounded-lg shadow-md bg-muted`}
                            >
                              <FileIcon className="h-5 w-5 text-foreground" />
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate text-foreground">
                                {file.originalName}
                              </p>
                              {file.newName && (
                                <p className="text-xs text-muted-foreground mt-1 font-medium">
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
                                  className="hover:scale-105 transition-all duration-300"
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setFileToDelete(file);
                                  setDeleteDialogOpen(true);
                                }}
                                className="hover:scale-105 transition-all duration-300 hover:text-red-600 h-10 w-10"
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

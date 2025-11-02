import {
  ClipboardList,
  CloudUpload,
  CreditCard,
  Download,
  File,
  FileText,
  FileUp,
  FolderOpen,
  GraduationCap,
  Heart,
  HelpCircle,
  ImageIcon,
  Moon,
  RefreshCw,
  Sun,
  Syringe,
  Tag,
  Trash2,
  User,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DropzoneHandle } from "@/components/kibo-ui/dropzone";
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
} from "@/components/kibo-ui/dropzone";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";

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
    color: "rgb(103, 80, 164)", // Deep Purple
  },
  Diplom: {
    name: "Диплом/Аттестат",
    icon: GraduationCap,
    color: "rgb(171, 71, 188)", // Purple
  },
  ENT: {
    name: "ЕНТ",
    icon: ClipboardList,
    color: "rgb(251, 140, 0)", // Orange
  },
  Lgota: {
    name: "Льгота",
    icon: Tag,
    color: "rgb(67, 160, 71)", // Green
  },
  Unclassified: {
    name: "Неизвестно",
    icon: HelpCircle,
    color: "rgb(117, 117, 117)", // Grey
  },
  Privivka: {
    name: "Прививочный паспорт",
    icon: Syringe,
    color: "rgb(0, 172, 193)", // Cyan
  },
  MedSpravka: {
    name: "Медицинская справка",
    icon: Heart,
    color: "rgb(229, 57, 53)", // Red
  },
};

const getFileIcon = (filename?: string) => {
  if (!filename) return File;
  const ext = String(filename).toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "pdf": {
      return FileText;
    }
    case "jpg":
    case "jpeg":
    case "png": {
      return ImageIcon;
    }
    default: {
      return File;
    }
  }
};

// The backend now emits canonical category values (e.g. "Udostoverenie", "Diplom", "ENT").
// Use them directly — only default to "Unclassified" when missing.
const normalizeCategoryKey = (raw?: string | null): string => {
  if (!raw) return "Unclassified";
  return String(raw).trim();
};

// Split into smaller components to reduce re-renders. Keep them in the same file
// and memoize where appropriate.

const THEME_KEY = "ai_reception_theme";

// HeaderBar: depends only on isDark and toggle
const HeaderBar = React.memo(function HeaderBar({
  isDark,
  toggleDark,
}: {
  isDark: boolean;
  toggleDark: () => void;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-card shadow-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center">
            <a href="#" aria-label="Home" className="block group">
              <img
                src={isDark ? "/logo_light.png" : "/logo_dark.png"}
                alt="Logo"
                className="h-14 w-fit object-contain transition-transform duration-300 group-hover:scale-105"
              />
            </a>
          </div>

          <div className="flex-1 flex items-center justify-center">
            <h1
              className={`text-xl sm:text-2xl font-semibold tracking-tight ${
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
              onClick={toggleDark}
              className="rounded-full h-12 w-12 hover:bg-slate-200 dark:hover:bg-slate-800 transition-all duration-300 hover:scale-105 shadow-none"
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
  );
});

const FormCard = React.memo(function FormCard({
  name,
  lastName,
  setName,
  setLastName,
  isLoading,
  onPickFiles,
  onReset,
  isFormValid,
}: {
  name: string;
  lastName: string;
  setName: (v: string) => void;
  setLastName: (v: string) => void;
  isLoading: boolean;
  onPickFiles: () => void;
  onReset: () => void;
  isFormValid: () => boolean;
}) {
  return (
    <Card className="overflow-hidden shadow-md">
      <CardHeader className="py-5 px-4">
        <CardTitle className="flex items-center gap-3 text-foreground">
          <User className="h-6 w-6" />
          {strings.appHeader}
        </CardTitle>
      </CardHeader>
      <CardContent className="py-4 px-4">
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
              onClick={onPickFiles}
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
              onClick={onReset}
              className="flex-none whitespace-nowrap px-4 py-2"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Новый абитуриент
            </Button>
          </div>

          {isLoading && (
            <Progress value={undefined} className="w-full h-2 rounded-full" />
          )}
        </div>
      </CardContent>
    </Card>
  );
});

const DropzoneArea = React.memo(function DropzoneArea({
  dropzoneRef,
  onDrop,
  disabled,
  onPickFiles,
  isFormValid,
  isLoading,
}: {
  dropzoneRef: React.RefObject<DropzoneHandle | null>;
  onDrop: (accepted: File[], rejected: any[]) => void;
  disabled: boolean;
  onPickFiles: () => void;
  isFormValid: () => boolean;
  isLoading: boolean;
}) {
  return (
    <Dropzone
      ref={dropzoneRef}
      maxFiles={12}
      onDrop={onDrop}
      disabled={disabled}
      className="cursor-pointer transition-all duration-300 border-2 border-dashed overflow-hidden hover:scale-[1.01] shadow-sm hover:shadow-lg rounded-xl p-1"
    >
      <DropzoneEmptyState>
        <CardContent className="py-12 px-8">
          <div className="flex flex-col items-center justify-center text-center space-y-4">
            <CloudUpload className="h-14 w-14" />
            <div>
              <p className="text-xl font-bold text-foreground">
                Перетащите или нажмите, чтобы выбрать файлы
              </p>
              <p className="text-sm text-muted-foreground mt-3 font-medium">
                Поддерживаемые форматы: PDF, JPG, PNG
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                {Object.entries(categoryInfo)
                  .filter(([key]) => key !== "Unclassified")
                  .map(([key, info]) => {
                    const IconSmall = info.icon;
                    return (
                      <div
                        key={key}
                        className="flex items-center gap-2 px-2 py-1 rounded-full bg-muted/20"
                        style={{ opacity: 0.95 }}
                      >
                        <div
                          className="p-1 rounded-full"
                          style={{ background: info.color }}
                        >
                          <IconSmall className="h-3 w-3 text-white" />
                        </div>
                        <span className="text-xs">{info.name}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
            <Button
              variant="secondary"
              disabled={!isFormValid() || isLoading}
              onClick={(e) => {
                e.stopPropagation();
                onPickFiles();
              }}
              className="hover:scale-103 transition-all duration-300 shadow-sm hover:shadow-md px-4 py-2"
            >
              <FileUp className="mr-2 h-5 w-5" />
              Выбрать файлы
            </Button>
          </div>
        </CardContent>
      </DropzoneEmptyState>
      <DropzoneContent />
    </Dropzone>
  );
});

const FileRow = React.memo(function FileRow({
  file,
  info,
  selected,
  onToggle,
  onDownload,
  onDeleteDialog,
}: {
  file: UploadedFile;
  info: CategoryInfo | { name: string; icon: any; color: string };
  selected: boolean;
  onToggle: (uid: string) => void;
  onDownload: (file: UploadedFile) => void;
  onDeleteDialog: (file: UploadedFile) => void;
}) {
  const FileIcon = getFileIcon(file.originalName);
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/60 hover:shadow-sm transition-shadow">
      <div
        className="p-2 rounded-lg shadow-sm"
        style={{ background: info.color }}
      >
        <FileIcon className="h-5 w-5 text-white" />
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
          checked={selected}
          onCheckedChange={() => onToggle(file.uid)}
        />
        {normalizeCategoryKey(file.category) !== "Unclassified" && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDownload(file)}
            className="hover:scale-105 transition-all duration-300"
          >
            <Download className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDeleteDialog(file)}
          className="hover:scale-105 transition-all duration-300 hover:text-red-600 h-10 w-10"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

const FileGroup = React.memo(function FileGroup({
  category,
  categoryFiles,
  onDownloadFile,
  onToggle,
  selectedSet,
  onDeleteDialog,
}: {
  category: string;
  categoryFiles: UploadedFile[];
  onDownloadFile: (file: UploadedFile) => void;
  onToggle: (uid: string) => void;
  selectedSet: Set<string>;
  onDeleteDialog: (file: UploadedFile) => void;
}) {
  const info = categoryInfo[category] || {
    name: category,
    icon: File,
    color: "rgb(156, 163, 175)",
  };
  const Icon = info.icon;

  return (
    <Card
      key={category}
      className="overflow-hidden shadow-md hover:shadow-xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-3 rounded-lg"
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-full"
              style={{ background: info.color }}
            >
              <Icon className="h-5 w-5 text-white" />
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
                  if (f.id) onDownloadFile(f);
                });
              }}
              className="hover:scale-105 transition-all duration-300"
            >
              <Download className="h-5 w-5" />
            </Button>
          )}
        </div>

        <div className="space-y-3">
          {categoryFiles.map((file) => (
            <FileRow
              key={file.uid}
              file={file}
              info={info}
              selected={selectedSet.has(file.uid)}
              onToggle={onToggle}
              onDownload={onDownloadFile}
              onDeleteDialog={onDeleteDialog}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

export default function AIReceptionApp() {
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

  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  // Keep track of the name/lastname that were used to fetch the current
  // `files` list. This prevents accidental 403s when the user edits the
  // input fields but then operates on files that were fetched for a
  // different (previous) name/lastname.
  const [queriedName, setQueriedName] = useState<string | null>(null);
  const [queriedLastName, setQueriedLastName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<UploadedFile | null>(null);
  const dropzoneRef = useRef<DropzoneHandle | null>(null);

  useEffect(() => {
    try {
      document.documentElement.classList.toggle("dark", isDark);
      localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    } catch {
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

  // Recreate handlers with stable identities where useful
  const toggleDark = useCallback(() => setIsDark((v) => !v), []);

  const uploadFiles = useCallback(
    async (fileList: File[]) => {
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
          try {
            toast.error(strings.uploadFail);
          } catch {
            /* ignore if toast not available during SSR */
          }
          return;
        }

        const uploadResult = (await response.json().catch(() => ({}))) as {
          success?: UploadedFile[];
          unclassified?: UploadedFile[];
          failed?: { filename: string; error: string }[];
          summary?: Record<string, number>;
        };

        const filesUrl = `${getBackendOrigin()}/files?name=${encodeURIComponent(
          name
        )}&lastname=${encodeURIComponent(lastName)}`;
        const filesResponse = await fetch(filesUrl).catch(() => null);
        let persisted: UploadedFile[] = [];
        if (filesResponse && filesResponse.ok) {
          persisted = (await filesResponse.json()) as UploadedFile[];
        }

        const returned: UploadedFile[] = [
          ...(uploadResult.success || []),
          ...(uploadResult.unclassified || []),
        ];

        const merged = [
          ...returned,
          ...persisted.filter((p) => !returned.some((r) => r.uid === p.uid)),
        ];

        // Remember which name/lastname we used to obtain the current file
        // list so subsequent delete/download requests use the same values.
        setQueriedName(name);
        setQueriedLastName(lastName);

        setFiles(merged as UploadedFile[]);
        try {
          toast.success(strings.uploadSuccess);
        } catch {
          /* ignore if toast not available during SSR */
        }
      } catch (error) {
        console.error("Upload failed:", error);
        try {
          toast.error(strings.uploadFail);
        } catch {
          /* ignore if toast not available during SSR */
        }
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, name, lastName]
  );

  const handleDrop = useCallback(
    (acceptedFiles: File[], fileRejections: any[]) => {
      if (!acceptedFiles || acceptedFiles.length === 0) return;

      if (fileRejections && fileRejections.length > 0) {
        const message = fileRejections?.[0]?.errors?.[0]?.message;
        try {
          toast.error(message || strings.invalidFileType);
        } catch {
          /* ignore */
        }
        return;
      }

      if (!isFormValid()) {
        try {
          toast.error(strings.invalidForm);
        } catch {
          /* ignore */
        }
        return;
      }

      uploadFiles(acceptedFiles);
    },
    [isFormValid, uploadFiles]
  );

  const pickFiles = useCallback(() => {
    if (isLoading) return;
    if (!isFormValid()) {
      try {
        toast.error(strings.invalidForm);
      } catch {
        /* ignore */
      }
      return;
    }

    dropzoneRef.current?.open();
  }, [isFormValid, isLoading]);

  const deleteFile = useCallback(
    async (file: UploadedFile) => {
      if (!file.id || normalizeCategoryKey(file.category) === "Unclassified") {
        setFiles((prev) => prev.filter((f) => f !== file));
        return;
      }

      try {
        const useName = queriedName ?? name;
        const useLast = queriedLastName ?? lastName;

        const url = `${getBackendOrigin()}/files/${encodeURIComponent(
          file.id
        )}?name=${encodeURIComponent(useName)}&lastname=${encodeURIComponent(
          useLast
        )}`;
        const response = await fetch(url, { method: "DELETE" });

        if (!response.ok) {
          if (response.status === 404) {
            setFiles((prev) => prev.filter((f) => f !== file));
            return;
          }
          const text = await response.text().catch(() => "");
          console.error("Delete failed, status:", response.status, text);
          return;
        }

        const filesUrl = `${getBackendOrigin()}/files?name=${encodeURIComponent(
          useName
        )}&lastname=${encodeURIComponent(useLast)}`;
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
    },
    [name, lastName, queriedName, queriedLastName]
  );

  const downloadFile = useCallback(
    (file: UploadedFile) => {
      if (!file.id) return;
      const useName = queriedName ?? name;
      const useLast = queriedLastName ?? lastName;

      const url = `${getBackendOrigin()}/files/${encodeURIComponent(
        file.id
      )}?name=${encodeURIComponent(useName)}&lastname=${encodeURIComponent(
        useLast
      )}`;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.download = file.newName || file.originalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [name, lastName, queriedName, queriedLastName]
  );

  const downloadAll = useCallback(() => {
    const useName = queriedName ?? name;
    const useLast = queriedLastName ?? lastName;

    const url = `${getBackendOrigin()}/download_zip?name=${encodeURIComponent(
      useName
    )}&lastname=${encodeURIComponent(useLast)}`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.download = "documents.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [name, lastName]);

  const toggleSelection = useCallback((uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const allUids = files.map((f) => f.uid);
      if (prev.size === files.length && files.length > 0)
        return new Set<string>();
      return new Set(allUids);
    });
  }, [files]);

  const deleteSelected = useCallback(async () => {
    const filesToDelete = files.filter((f) => selected.has(f.uid));
    for (const file of filesToDelete) {
      // eslint-disable-next-line no-await-in-loop
      await deleteFile(file);
    }
    setSelected(new Set());
  }, [files, selected, deleteFile]);

  const reset = useCallback(() => {
    setName("");
    setLastName("");
    setFiles([]);
    setSelected(new Set());
  }, []);

  const groupedFiles = React.useMemo(() => {
    return files.reduce((acc, file) => {
      const categoryKey = normalizeCategoryKey(file.category);
      if (!acc[categoryKey]) acc[categoryKey] = [];
      acc[categoryKey].push(file);
      return acc;
    }, {} as Record<string, UploadedFile[]>);
  }, [files]);

  const openDeleteDialogForFile = useCallback((file: UploadedFile) => {
    setFileToDelete(file);
    setDeleteDialogOpen(true);
  }, []);

  return (
    <div className="min-h-screen bg-background dark:bg-background transition-colors">
      <HeaderBar isDark={isDark} toggleDark={toggleDark} />

      <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <FormCard
          name={name}
          lastName={lastName}
          setName={setName}
          setLastName={setLastName}
          isLoading={isLoading}
          onPickFiles={pickFiles}
          onReset={reset}
          isFormValid={isFormValid}
        />

        <DropzoneArea
          dropzoneRef={dropzoneRef}
          onDrop={handleDrop}
          disabled={!isFormValid() || isLoading}
          onPickFiles={pickFiles}
          isFormValid={isFormValid}
          isLoading={isLoading}
        />

        {files.length === 0 ? (
          <Card className="overflow-hidden">
            <CardContent className="py-16 px-8">
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
                  className="hover:scale-103 transition-all duration-300 px-3 py-1 shadow-sm"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Скачать всё
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => {
                    if (selected.size > 0) setDeleteDialogOpen(true);
                  }}
                  className="hover:scale-103 transition-all duration-300 disabled:hover:scale-100 px-3 py-1 shadow-sm"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Удалить
                </Button>
              </div>
            </div>

            {Object.entries(groupedFiles).map(([category, categoryFiles]) => (
              <FileGroup
                key={category}
                category={category}
                categoryFiles={categoryFiles}
                onDownloadFile={downloadFile}
                onToggle={toggleSelection}
                selectedSet={selected}
                onDeleteDialog={openDeleteDialogForFile}
              />
            ))}

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
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

"use client";

import { UploadIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";
import type { DropEvent, DropzoneOptions, FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";

type DropzoneContextType = {
  src?: File[];
  accept?: DropzoneOptions["accept"];
  maxSize?: DropzoneOptions["maxSize"];
  minSize?: DropzoneOptions["minSize"];
  maxFiles?: DropzoneOptions["maxFiles"];
};

const renderBytes = (bytes: number) => {
  const units = ["Б", "КБ", "МБ"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)}${units[unitIndex]}`;
};

const DropzoneContext = createContext<DropzoneContextType | undefined>(
  undefined
);

export type DropzoneProps = Omit<DropzoneOptions, "onDrop"> & {
  src?: File[];
  className?: string;
  onDrop?: (
    acceptedFiles: File[],
    fileRejections: FileRejection[],
    event: DropEvent
  ) => void;
  children?: ReactNode;
};

export type DropzoneHandle = {
  open: () => void;
};

export const Dropzone = forwardRef<DropzoneHandle, DropzoneProps>(
  (
    {
      accept,
      maxFiles = 12,
      maxSize,
      minSize,
      onDrop,
      onError,
      disabled,
      src,
      className,
      children,
      ...props
    }: DropzoneProps,
    ref
  ) => {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(ref, () => ({
      open: () => inputRef.current?.click(),
    }));

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
      accept,
      maxFiles,
      maxSize,
      minSize,
      onError,
      disabled,
      onDrop: (acceptedFiles, fileRejections, event) => {
        if (fileRejections.length > 0) {
          const message = fileRejections.at(0)?.errors.at(0)?.message;
          onError?.(new Error(message));
          return;
        }

        onDrop?.(acceptedFiles, fileRejections, event);
      },
      ...props,
    });

    // get root props and ensure click anywhere triggers the native file input
    const rootProps = getRootProps();
    const handleRootClick = (e: any) => {
      // call any existing handler from getRootProps
      try {
        rootProps.onClick?.(e);
      } catch (err) {
        /* ignore */
      }

      if (!disabled) {
        inputRef.current?.click();
      }
    };

    const handleRootKeyDown = (e: React.KeyboardEvent) => {
      try {
        // forward to any existing handler
        (rootProps as any).onKeyDown?.(e);
      } catch (err) {
        /* ignore */
      }

      if (disabled) return;

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        inputRef.current?.click();
      }
    };

    return (
      <DropzoneContext.Provider
        value={{ src, accept, maxSize, minSize, maxFiles }}
      >
        <div
          className={cn(
            "relative h-auto w-full flex-col items-center justify-center overflow-hidden p-6 sm:p-8 rounded-lg",
            isDragActive && "outline-none ring-1 ring-ring",
            className
          )}
          aria-disabled={disabled}
          role="button"
          tabIndex={disabled ? -1 : 0}
          {...(rootProps as any)}
          onClick={handleRootClick}
          onKeyDown={handleRootKeyDown}
        >
          <input
            {...getInputProps()}
            ref={inputRef as any}
            disabled={disabled}
          />
          {children}
        </div>
      </DropzoneContext.Provider>
    );
  }
);

Dropzone.displayName = "Dropzone";

const useDropzoneContext = () => {
  const context = useContext(DropzoneContext);

  if (!context) {
    throw new Error("useDropzoneContext must be used within a Dropzone");
  }

  return context;
};

export type DropzoneContentProps = {
  children?: ReactNode;
  className?: string;
};

const maxLabelItems = 3;

export const DropzoneContent = ({
  children,
  className,
}: DropzoneContentProps) => {
  const { src } = useDropzoneContext();

  if (!src) {
    return null;
  }

  if (children) {
    return children;
  }

  return (
    <div className={cn("flex flex-col items-center justify-center", className)}>
      <div className="flex items-center justify-center rounded-md bg-muted text-muted-foreground w-10 h-10 sm:w-12 sm:h-12">
        <UploadIcon className="w-5 h-5 sm:w-6 sm:h-6" />
      </div>
      <p className="my-2 w-full truncate font-medium text-sm">
        {src.length > maxLabelItems
          ? `${new Intl.ListFormat("ru").format(
              src.slice(0, maxLabelItems).map((file) => file.name)
            )} и ещё ${src.length - maxLabelItems}`
          : new Intl.ListFormat("ru").format(src.map((file) => file.name))}
      </p>
      <p className="w-full text-wrap text-muted-foreground text-xs">
        Перетащите файлы сюда или нажмите для замены
      </p>
    </div>
  );
};

export type DropzoneEmptyStateProps = {
  children?: ReactNode;
  className?: string;
};

export const DropzoneEmptyState = ({
  children,
  className,
}: DropzoneEmptyStateProps) => {
  const { src, accept, maxSize, minSize, maxFiles } = useDropzoneContext();

  if (src) {
    return null;
  }

  if (children) {
    return children;
  }

  let caption = "";

  if (accept) {
    caption += "Принимает ";
    caption += new Intl.ListFormat("ru").format(Object.keys(accept));
  }

  if (minSize && maxSize) {
    caption += ` от ${renderBytes(minSize)} до ${renderBytes(maxSize)}`;
  } else if (minSize) {
    caption += ` не менее ${renderBytes(minSize)}`;
  } else if (maxSize) {
    caption += ` меньше ${renderBytes(maxSize)}`;
  }

  return (
    <div className={cn("flex flex-col items-center justify-center", className)}>
      <div className="flex items-center justify-center rounded-md bg-muted text-muted-foreground w-10 h-10 sm:w-12 sm:h-12">
        <UploadIcon className="w-5 h-5 sm:w-6 sm:h-6" />
      </div>
      <p className="my-2 w-full truncate text-wrap font-medium text-sm">
        {maxFiles === 1 ? "Загрузить файл" : "Загрузить файлы"}
      </p>
      <p className="w-full truncate text-wrap text-muted-foreground text-xs">
        Перетащите сюда или нажмите, чтобы выбрать
      </p>
      {caption && (
        <p className="text-wrap text-muted-foreground text-xs">{caption}.</p>
      )}
    </div>
  );
};

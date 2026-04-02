/**
 * Review queue API client
 * Handles communication with backend /admin/* endpoints
 */

const getBackendOrigin = () => "";

export interface Document {
  id: string;
  original_name: string;
  stored_filename: string;
  processing_path: string | null;
  processing_error: string | null;
  applicant_name: string;
  applicant_lastname: string;
  category_predicted: string;
  category_confidence: number;
  category_final: string | null;
  status:
    | "processing"
    | "uploaded"
    | "queued"
    | "in_review"
    | "resolved"
    | "unclassified"
    | "failed";
  assigned_reviewer_id: string | null;
  uploaded_at: string;
  updated_at: string;
  text_excerpt: string | null;
}

interface ReviewQueueResponse {
  data: Document[];
  next_cursor: string | null;
}

export interface ReviewAction {
  id: number;
  document_id: string;
  reviewer_email: string;
  action: "claim" | "release" | "accept" | "override" | "reject";
  from_category: string | null;
  to_category: string | null;
  comment: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface ResolveRequest {
  final_category: string;
  applicant_name?: string;
  applicant_lastname?: string;
  comment?: string;
}

export interface DocumentPreview {
  type: "image" | "text" | "none" | "pdf";
  text?: string;
  message?: string;
  url?: string;
}

/**
 * Get review queue documents
 */
export async function getReviewQueue(params?: {
  status?: string;
  limit?: number;
}): Promise<Document[]> {
  const limit = params?.limit ?? 100;
  const documents: Document[] = [];
  let cursor: string | null = null;

  do {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    searchParams.set("limit", limit.toString());
    if (cursor) searchParams.set("cursor", cursor);

    const url = `${getBackendOrigin()}/admin/review-queue${
      searchParams.toString() ? `?${searchParams.toString()}` : ""
    }`;

    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.detail || "Не удалось получить очередь на проверку");
    }

    const payload = (await response.json()) as ReviewQueueResponse;
    documents.push(...payload.data);
    cursor = payload.next_cursor;
  } while (cursor);

  return documents;
}

/**
 * Claim a document for review
 */
export async function claimDocument(documentId: string): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/claim`,
    {
      method: "POST",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось принять документ");
  }

  return response.json();
}

/**
 * Release a claimed document back to queue
 */
export async function releaseDocument(documentId: string): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/release`,
    {
      method: "POST",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось вернуть документ в очередь");
  }

  return response.json();
}

/**
 * Resolve a document review
 */
export async function resolveDocument(
  documentId: string,
  request: ResolveRequest,
): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/resolve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось завершить проверку документа");
  }

  return response.json();
}

/**
 * Get document by ID
 */
export async function getDocument(documentId: string): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось получить документ");
  }

  return response.json();
}

/**
 * Get document preview
 */
export async function getDocumentPreview(
  documentId: string,
): Promise<DocumentPreview> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/preview`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось получить предпросмотр");
  }

  const contentType = response.headers.get("Content-Type");
  if (contentType?.includes("application/pdf")) {
    const blob = await response.blob();
    return {
      type: "pdf",
      url: URL.createObjectURL(blob),
    };
  }

  if (contentType?.startsWith("image/")) {
    const blob = await response.blob();
    return {
      type: "image",
      url: URL.createObjectURL(blob),
    };
  }

  return response.json();
}

/**
 * Get document audit trail
 */
export async function getDocumentAudit(
  documentId: string,
): Promise<ReviewAction[]> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/audit`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || error.detail || "Не удалось получить журнал действий");
  }

  return response.json();
}

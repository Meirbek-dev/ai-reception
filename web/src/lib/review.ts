/**
 * Review queue API client
 * Handles communication with backend /admin/* endpoints
 */

const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

export interface Document {
  id: string;
  original_name: string;
  stored_filename: string;
  applicant_name: string;
  applicant_lastname: string;
  category_predicted: string;
  category_confidence: number;
  category_final: string | null;
  status: "uploaded" | "queued" | "in_review" | "resolved";
  assigned_reviewer_id: string | null;
  uploaded_at: string;
  updated_at: string;
  text_excerpt: string | null;
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
  image?: string; // base64 data URL
  text?: string;
  message?: string;
  url?: string; // URL for PDF files
}

/**
 * Get review queue documents
 */
export async function getReviewQueue(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<Document[]> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  if (params?.offset) searchParams.set("offset", params.offset.toString());

  const url = `${getBackendOrigin()}/admin/review-queue${searchParams.toString() ? `?${searchParams.toString()}` : ""
    }`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось получить очередь на проверку");
  }

  return response.json();
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
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось принять документ");
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
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось вернуть документ в очередь");
  }

  return response.json();
}

/**
 * Resolve a document review
 */
export async function resolveDocument(
  documentId: string,
  request: ResolveRequest
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
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось завершить проверку документа");
  }

  return response.json();
}

/**
 * Get document by ID
 */
export async function getDocument(documentId: string): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/documents/${documentId}`,
    {
      method: "GET",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось получить документ");
  }

  return response.json();
}

/**
 * Get document preview
 */
export async function getDocumentPreview(
  documentId: string
): Promise<DocumentPreview> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/documents/${documentId}/preview`,
    {
      method: "GET",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось получить предпросмотр");
  }

  // Check if response is PDF
  const contentType = response.headers.get("Content-Type");
  if (contentType?.includes("application/pdf")) {
    // For PDFs, create a blob URL
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    return {
      type: "pdf",
      url,
    };
  }

  // Otherwise, parse as JSON (image/text/none)
  return response.json();
}

/**
 * Get document audit trail
 */
export async function getDocumentAudit(
  documentId: string
): Promise<ReviewAction[]> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/documents/${documentId}/audit`,
    {
      method: "GET",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Не удалось получить журнал действий");
  }

  return response.json();
}

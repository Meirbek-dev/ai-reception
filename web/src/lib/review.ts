/**
 * Review queue API client
 * Handles communication with backend /admin/* endpoints
 */

const getBackendOrigin = () =>
  import.meta.env?.DEV ? "http://localhost:5040" : window.location.origin;

export interface Document {
  id: number;
  original_name: string;
  stored_filename: string;
  applicant_name: string;
  applicant_lastname: string;
  category_predicted: string;
  category_confidence: number;
  category_final: string | null;
  status: "uploaded" | "queued" | "in_review" | "resolved";
  assigned_reviewer_id: number | null;
  uploaded_at: string;
  updated_at: string;
  text_excerpt: string | null;
}

export interface ReviewAction {
  id: number;
  document_id: number;
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
  type: "image" | "text" | "none";
  image?: string; // base64 data URL
  text?: string;
  message?: string;
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

  const url = `${getBackendOrigin()}/admin/review-queue${
    searchParams.toString() ? `?${searchParams.toString()}` : ""
  }`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to get review queue");
  }

  return response.json();
}

/**
 * Claim a document for review
 */
export async function claimDocument(documentId: number): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/claim`,
    {
      method: "POST",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to claim document");
  }

  return response.json();
}

/**
 * Release a claimed document back to queue
 */
export async function releaseDocument(documentId: number): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/review-queue/${documentId}/release`,
    {
      method: "POST",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to release document");
  }

  return response.json();
}

/**
 * Resolve a document review
 */
export async function resolveDocument(
  documentId: number,
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
    throw new Error(error.detail || "Failed to resolve document");
  }

  return response.json();
}

/**
 * Get document by ID
 */
export async function getDocument(documentId: number): Promise<Document> {
  const response = await fetch(
    `${getBackendOrigin()}/admin/documents/${documentId}`,
    {
      method: "GET",
      credentials: "include",
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to get document");
  }

  return response.json();
}

/**
 * Get document preview
 */
export async function getDocumentPreview(
  documentId: number
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
    throw new Error(error.detail || "Failed to get preview");
  }

  return response.json();
}

/**
 * Get document audit trail
 */
export async function getDocumentAudit(
  documentId: number
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
    throw new Error(error.detail || "Failed to get audit trail");
  }

  return response.json();
}

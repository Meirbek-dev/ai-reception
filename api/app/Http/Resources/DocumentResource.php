<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class DocumentResource extends JsonResource
{
    /**
     * Matches DocumentResponse (Pydantic) from Python review.py.
     */
    public function toArray(Request $request): array
    {
        return [
            'id'                    => $this->id,
            'original_name'         => $this->original_name,
            'stored_filename'       => $this->stored_filename ?? '',
            'processing_path'       => $this->processing_path,
            'processing_error'      => $this->processing_error,
            'applicant_name'        => $this->applicant_name,
            'applicant_lastname'    => $this->applicant_lastname,
            'category_predicted'    => $this->category_predicted,
            'category_confidence'   => (float) $this->category_confidence,
            'category_final'        => $this->category_final,
            'status'                => $this->effectiveStatus(),
            'assigned_reviewer_id'  => $this->assigned_reviewer_id,
            'size_bytes'            => $this->size_bytes,
            'review_started_at'     => $this->review_started_at?->toIso8601String(),
            'resolved_at'           => $this->resolved_at?->toIso8601String(),
            'uploaded_at'           => $this->created_at->toIso8601String(),
            'updated_at'            => $this->updated_at->toIso8601String(),
            'text_excerpt'          => $this->whenLoaded('text', fn () => $this->text?->text_excerpt),
        ];
    }
}

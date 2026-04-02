<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class ReviewActionResource extends JsonResource
{
    /**
     * Matches ReviewActionResponse (Pydantic) from Python review.py.
     */
    public function toArray(Request $request): array
    {
        return [
            'id'               => $this->id,
            'document_id'      => $this->document_id,
            'reviewer_email'   => $this->whenLoaded('reviewer', fn () => $this->reviewer?->email ?? 'unknown', 'unknown'),
            'action'           => $this->action,
            'from_category'    => $this->from_category,
            'to_category'      => $this->to_category,
            'comment'          => $this->comment,
            'duration_seconds' => $this->duration_seconds,
            'created_at'       => $this->created_at?->toIso8601String(),
        ];
    }
}

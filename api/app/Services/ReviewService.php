<?php

namespace App\Services;

use App\Models\Document;
use App\Models\ReviewAction;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class ReviewService
{
    /**
     * Get documents in the review queue.
     *
     * Mirrors get_review_queue() from Python.
     */
    public function getQueue(?string $status, int $limit, ?string $cursor): array
    {
        $query = Document::with(['text', 'reviewer'])
            ->whereNull('processing_state');

        if ($status !== null) {
            $query->where('status', $status);
        }

        $cursorData = $this->decodeCursor($cursor);
        if ($cursorData !== null) {
            $query->where(function ($builder) use ($cursorData) {
                $builder->where('created_at', '>', $cursorData['created_at'])
                    ->orWhere(function ($inner) use ($cursorData) {
                        $inner->where('created_at', '=', $cursorData['created_at'])
                            ->where('id', '>', $cursorData['id']);
                    });
            });
        }

        $documents = $query
            ->orderBy('created_at', 'asc')
            ->orderBy('id', 'asc')
            ->limit($limit + 1)
            ->get();

        $nextCursor = null;
        if ($documents->count() > $limit) {
            $last = $documents->pop();
            if ($last) {
                $nextCursor = $this->encodeCursor(
                    (string) $last->created_at,
                    (string) $last->id,
                );
            }
        }

        return [
            'documents' => $documents,
            'next_cursor' => $nextCursor,
        ];
    }

    /**
     * Claim a document for review.
     *
     * Mirrors claim_document() — uses a DB transaction to prevent double-claim.
     */
    public function claim(string $documentId, User $reviewer): Document
    {
        return DB::transaction(function () use ($documentId, $reviewer) {
            /** @var Document|null $document */
            $document = Document::with('text')->lockForUpdate()->find($documentId);

            if (! $document) {
                throw new \InvalidArgumentException("Документ {$documentId} не найден");
            }

            if ($document->status !== 'queued') {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} не может быть принят (статус: {$document->status})"
                );
            }

            if ($document->assigned_reviewer_id !== null) {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} уже принят другим рецензентом"
                );
            }

            $now = now();
            $document->update([
                'assigned_reviewer_id' => $reviewer->id,
                'status'               => 'in_review',
                'review_started_at'    => $now,
                'updated_at'           => $now,
            ]);

            ReviewAction::create([
                'document_id'   => $documentId,
                'reviewer_id'   => $reviewer->id,
                'action'        => 'claim',
                'from_category' => $document->category_predicted,
                'to_category'   => null,
                'comment'       => null,
                'duration_seconds' => null,
                'created_at'    => $now,
            ]);

            Log::info("Document {$documentId} claimed by reviewer {$reviewer->email}");

            return $document->fresh(['text', 'reviewer']);
        });
    }

    /**
     * Release a claimed document back to queue.
     *
     * Mirrors release_document() from Python.
     */
    public function release(string $documentId, User $reviewer): Document
    {
        return DB::transaction(function () use ($documentId, $reviewer) {
            /** @var Document|null $document */
            $document = Document::with('text')->lockForUpdate()->find($documentId);

            if (! $document) {
                throw new \InvalidArgumentException("Документ {$documentId} не найден");
            }

            if ($document->status !== 'in_review') {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} не находится в обработке (статус: {$document->status})"
                );
            }

            if ($document->assigned_reviewer_id !== $reviewer->id) {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} не закреплён за этим рецензентом"
                );
            }

            $now = now();
            $document->update([
                'assigned_reviewer_id' => null,
                'status'               => 'queued',
                'review_started_at'    => null,
                'updated_at'           => $now,
            ]);

            ReviewAction::create([
                'document_id'      => $documentId,
                'reviewer_id'      => $reviewer->id,
                'action'           => 'release',
                'from_category'    => $document->category_predicted,
                'to_category'      => null,
                'comment'          => null,
                'duration_seconds' => null,
                'created_at'       => $now,
            ]);

            Log::info("Document {$documentId} released by reviewer {$reviewer->email}");

            return $document->fresh(['text', 'reviewer']);
        });
    }

    /**
     * Resolve a document review with a final category.
     *
     * Mirrors resolve_document() from Python.
     */
    public function resolve(
        string $documentId,
        User $reviewer,
        string $finalCategory,
        ?string $applicantName,
        ?string $applicantLastname,
        ?string $comment
    ): Document {
        return DB::transaction(function () use ($documentId, $reviewer, $finalCategory, $applicantName, $applicantLastname, $comment) {
            /** @var Document|null $document */
            $document = Document::with('text')->lockForUpdate()->find($documentId);

            if (! $document) {
                throw new \InvalidArgumentException("Документ {$documentId} не найден");
            }

            if ($document->status !== 'in_review') {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} не находится в обработке (статус: {$document->status})"
                );
            }

            if ($document->assigned_reviewer_id !== $reviewer->id) {
                throw new \InvalidArgumentException(
                    "Документ {$documentId} не закреплён за этим рецензентом"
                );
            }

            $durationSeconds = null;
            if ($document->review_started_at) {
                $durationSeconds = (int) $document->review_started_at->diffInSeconds(now());
            }

            // Determine action type
            $actionType = $finalCategory === $document->category_predicted
                ? 'accept'
                : 'override';

            $now = now();
            $updates = [
                'category_final' => $finalCategory,
                'status'         => 'resolved',
                'resolved_at'    => $now,
                'updated_at'     => $now,
            ];
            if ($applicantName !== null) {
                $updates['applicant_name'] = $applicantName;
                $updates['applicant_name_normalized'] = $this->normalizeApplicantLookup($applicantName);
            }
            if ($applicantLastname !== null) {
                $updates['applicant_lastname'] = $applicantLastname;
                $updates['applicant_lastname_normalized'] = $this->normalizeApplicantLookup($applicantLastname);
            }
            $document->update($updates);

            ReviewAction::create([
                'document_id'      => $documentId,
                'reviewer_id'      => $reviewer->id,
                'action'           => $actionType,
                'from_category'    => $document->category_predicted,
                'to_category'      => $finalCategory,
                'comment'          => $comment,
                'duration_seconds' => $durationSeconds,
                'created_at'       => $now,
            ]);

            Log::info(
                "Document {$documentId} resolved by {$reviewer->email}: "
                ."{$document->category_predicted} -> {$finalCategory} in {$durationSeconds}s"
            );

            return $document->fresh(['text', 'reviewer']);
        });
    }

    /**
     * Get the audit trail for a document.
     *
     * Mirrors get_document_audit_trail() from Python.
     */
    public function getAuditTrail(string $documentId): \Illuminate\Database\Eloquent\Collection
    {
        return ReviewAction::with('reviewer')
            ->where('document_id', $documentId)
            ->orderBy('created_at', 'asc')
            ->get();
    }

    /**
     * Get a single document with related data.
     */
    public function findDocument(string $documentId): ?Document
    {
        return Document::with(['text', 'reviewer'])->find($documentId);
    }

    private function encodeCursor(string $createdAt, string $id): string
    {
        return rtrim(strtr(base64_encode(json_encode([
            'created_at' => $createdAt,
            'id' => $id,
        ], JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
    }

    private function decodeCursor(?string $cursor): ?array
    {
        if (! $cursor) {
            return null;
        }

        $decoded = base64_decode(strtr($cursor, '-_', '+/'), true);
        if ($decoded === false) {
            return null;
        }

        try {
            $payload = json_decode($decoded, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return null;
        }

        if (! isset($payload['created_at'], $payload['id'])) {
            return null;
        }

        return [
            'created_at' => $payload['created_at'],
            'id' => $payload['id'],
        ];
    }

    private function normalizeApplicantLookup(string $value): string
    {
        $normalized = mb_strtolower(trim($value));
        $normalized = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $normalized) ?? '';

        return trim($normalized);
    }
}

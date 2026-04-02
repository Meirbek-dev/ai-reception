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
    public function getQueue(?string $status, int $limit, int $offset): \Illuminate\Database\Eloquent\Collection
    {
        $query = Document::with(['text', 'reviewer']);

        if ($status === null) {
            $query->where('status', 'queued');
        } else {
            $query->where('status', $status);
        }

        return $query
            ->orderBy('created_at', 'asc')
            ->limit($limit)
            ->offset($offset)
            ->get();
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

            // Calculate duration from last claim action
            $claimAction = ReviewAction::where('document_id', $documentId)
                ->where('reviewer_id', $reviewer->id)
                ->where('action', 'claim')
                ->orderByDesc('created_at')
                ->first();

            $durationSeconds = null;
            if ($claimAction && $claimAction->created_at) {
                $durationSeconds = (int) now()->diffInSeconds($claimAction->created_at);
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
            }
            if ($applicantLastname !== null) {
                $updates['applicant_lastname'] = $applicantLastname;
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
}

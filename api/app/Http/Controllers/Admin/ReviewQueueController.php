<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Resources\DocumentResource;
use App\Http\Resources\ReviewActionResource;
use App\Services\ReviewService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

class ReviewQueueController extends Controller
{
    public function __construct(private ReviewService $reviewService) {}

    // -------------------------------------------------------------------------
    // GET /api/admin/review-queue
    // -------------------------------------------------------------------------

    public function index(Request $request): JsonResponse
    {
        $status = $request->query('status');
        $limit  = min((int) $request->query('limit', 50), 100);
        $cursor = $request->query('cursor');

        // Validate status enum
        $validStatuses = ['uploaded', 'queued', 'in_review', 'resolved'];
        if ($status !== null && ! in_array($status, $validStatuses, true)) {
            return response()->json(['message' => 'Invalid status value'], 422);
        }

        $result = $this->reviewService->getQueue($status, $limit, $cursor);

        return response()->json([
            'data' => DocumentResource::collection($result['documents']),
            'next_cursor' => $result['next_cursor'],
        ]);
    }

    // -------------------------------------------------------------------------
    // POST /api/admin/review-queue/{document}/claim
    // -------------------------------------------------------------------------

    public function claim(Request $request, string $document): JsonResponse
    {
        try {
            $doc = $this->reviewService->claim($document, $request->user());
            return response()->json(new DocumentResource($doc));
        } catch (\InvalidArgumentException $e) {
            return response()->json(['message' => $e->getMessage()], 400);
        }
    }

    // -------------------------------------------------------------------------
    // POST /api/admin/review-queue/{document}/release
    // -------------------------------------------------------------------------

    public function release(Request $request, string $document): JsonResponse
    {
        try {
            $doc = $this->reviewService->release($document, $request->user());
            return response()->json(new DocumentResource($doc));
        } catch (\InvalidArgumentException $e) {
            return response()->json(['message' => $e->getMessage()], 400);
        }
    }

    // -------------------------------------------------------------------------
    // POST /api/admin/review-queue/{document}/resolve
    // -------------------------------------------------------------------------

    public function resolve(Request $request, string $document): JsonResponse
    {
        $data = $request->validate([
            'final_category'    => 'required|string|min:1|max:100',
            'applicant_name'    => 'nullable|string|max:200',
            'applicant_lastname'=> 'nullable|string|max:200',
            'comment'           => 'nullable|string|max:1000',
        ]);

        try {
            $doc = $this->reviewService->resolve(
                $document,
                $request->user(),
                $data['final_category'],
                $data['applicant_name'] ?? null,
                $data['applicant_lastname'] ?? null,
                $data['comment'] ?? null,
            );
            return response()->json(new DocumentResource($doc));
        } catch (\InvalidArgumentException $e) {
            return response()->json(['message' => $e->getMessage()], 400);
        }
    }

    // -------------------------------------------------------------------------
    // GET /api/admin/review-queue/{document}
    // -------------------------------------------------------------------------

    public function show(string $document): JsonResponse
    {
        $doc = $this->reviewService->findDocument($document);
        if (! $doc) {
            return response()->json(['message' => "Документ {$document} не найден"], 404);
        }
        return response()->json(new DocumentResource($doc));
    }

    // -------------------------------------------------------------------------
    // GET /api/admin/review-queue/{document}/audit
    // -------------------------------------------------------------------------

    public function audit(string $document): JsonResponse
    {
        $doc = $this->reviewService->findDocument($document);
        if (! $doc) {
            return response()->json(['message' => "Документ {$document} не найден"], 404);
        }

        $actions = $this->reviewService->getAuditTrail($document);
        return response()->json(ReviewActionResource::collection($actions));
    }

    // -------------------------------------------------------------------------
    // GET /api/admin/review-queue/{document}/preview
    // -------------------------------------------------------------------------

    public function preview(string $document): JsonResponse|Response|BinaryFileResponse
    {
        $doc = $this->reviewService->findDocument($document);
        if (! $doc) {
            return response()->json(['message' => "Документ {$document} не найден"], 404);
        }

        if (! $doc->stored_filename) {
            return response()->json(['type' => 'none', 'message' => 'Документ не имеет сохранённого файла'], 404);
        }

        $filePath = storage_path('app/'.$doc->stored_filename);

        if (! file_exists($filePath)) {
            return response()->json(['type' => 'none', 'message' => 'Файл документа не найден на диске'], 404);
        }

        $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));

        // For PDFs return the actual file inline
        if ($ext === 'pdf') {
            $encodedName = rawurlencode($doc->original_name);
            return response()->file($filePath, [
                'Content-Type'        => 'application/pdf',
                'Content-Disposition' => "inline; filename*=UTF-8''{$encodedName}",
                'Cache-Control'       => 'private, max-age=3600',
            ]);
        }

        // For images stream the actual image file inline.
        if (in_array($ext, ['jpg', 'jpeg', 'png'], true)) {
            $mimeType = in_array($ext, ['jpg', 'jpeg'], true) ? 'image/jpeg' : 'image/png';
            $encodedName = rawurlencode($doc->original_name);

            return response()->file($filePath, [
                'Content-Type'        => $mimeType,
                'Content-Disposition' => "inline; filename*=UTF-8''{$encodedName}",
                'Cache-Control'       => 'private, max-age=3600',
            ]);
        }

        // Fallback: text excerpt
        if ($doc->text && $doc->text->text_excerpt) {
            return response()->json([
                'type' => 'text',
                'text' => $doc->text->text_excerpt,
            ]);
        }

        return response()->json([
            'type'    => 'none',
            'message' => 'Предпросмотр недоступен для этого документа',
        ]);
    }
}

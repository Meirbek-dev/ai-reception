<?php

namespace App\Http\Controllers;

use App\Services\DocumentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\StreamedResponse;

class FileController extends Controller
{
    public function __construct(private DocumentService $documentService) {}

    // -------------------------------------------------------------------------
    // GET /api/health
    // -------------------------------------------------------------------------

    public function health(): JsonResponse
    {
        return response()->json([
            'status'               => 'healthy',
            'version'              => '2.1.0',
            'workers'              => (int) config('app.max_workers', 1),
            'upload_folder_exists' => is_dir(storage_path('app/uploads')),
        ]);
    }

    // -------------------------------------------------------------------------
    // POST /api/upload
    // -------------------------------------------------------------------------

    public function upload(Request $request): JsonResponse
    {
        $request->validate([
            'name'     => 'required|string|min:1|max:100',
            'lastname' => 'required|string|min:1|max:100',
            'files'    => 'required|array|min:1|max:'.config('app.max_files_per_upload', 20),
            'files.*'  => 'file|mimes:pdf,jpeg,jpg,png|max:'.intdiv((int) config('app.max_file_size', 52428800), 1024),
        ]);

        $name     = $request->input('name');
        $lastname = $request->input('lastname');
        $files    = $request->file('files');

        $successful   = [];
        $unclassified = [];
        $failed       = [];

        foreach ($files as $file) {
            if (! $file->isValid()) {
                $failed[] = ['filename' => $file->getClientOriginalName(), 'error' => 'Invalid file'];
                continue;
            }

            $tmpPath = $file->getRealPath();
            $origName = $file->getClientOriginalName();

            try {
                $result = $this->documentService->processFile($tmpPath, $origName, $name, $lastname);

                if (str_starts_with((string) $result['status'], 'error')) {
                    $failed[] = ['filename' => $origName, 'error' => $result['status']];
                } elseif ($result['status'] === 'unclassified') {
                    $unclassified[] = $result;
                } else {
                    $successful[] = $result;
                }
            } catch (\Throwable $e) {
                Log::error("Upload processing failed for {$origName}: ".$e->getMessage());
                $failed[] = ['filename' => $origName, 'error' => 'Processing failed'];
            }
        }

        return response()->json([
            'success'      => $successful,
            'unclassified' => $unclassified,
            'failed'       => $failed,
            'summary'      => [
                'total'        => count($files),
                'successful'   => count($successful),
                'unclassified' => count($unclassified),
                'failed'       => count($failed),
            ],
        ]);
    }

    // -------------------------------------------------------------------------
    // GET /api/files
    // -------------------------------------------------------------------------

    public function index(Request $request): JsonResponse
    {
        $category = $request->query('category');
        $name     = $request->query('name');
        $lastname = $request->query('lastname');

        $files = $this->documentService->listFiles($category, $name, $lastname);

        return response()->json($files);
    }

    // -------------------------------------------------------------------------
    // GET /api/files/{id}
    // -------------------------------------------------------------------------

    public function show(Request $request, string $id): Response|StreamedResponse
    {
        $name     = $request->query('name');
        $lastname = $request->query('lastname');

        if (! $name || ! $lastname) {
            return response()->json(['message' => 'Access denied'], 403);
        }

        $found = $this->documentService->findFile($id, $name, $lastname);

        if (! $found) {
            return response()->json(['message' => 'File not found'], 404);
        }

        // Security: ensure file is within the uploads directory
        $realPath   = realpath($found['path']);
        $uploadsDir = realpath(storage_path('app/uploads'));
        if (! $realPath || ! str_starts_with($realPath, $uploadsDir)) {
            return response()->json(['message' => 'Access denied'], 403);
        }

        return response()->download($found['path'], $found['filename'], [
            'Content-Type' => 'application/octet-stream',
        ]);
    }

    // -------------------------------------------------------------------------
    // GET /api/download_zip
    // -------------------------------------------------------------------------

    public function downloadZip(Request $request): Response|StreamedResponse
    {
        $request->validate([
            'name'     => 'required|string|min:1|max:100',
            'lastname' => 'required|string|min:1|max:100',
        ]);

        $name     = $request->query('name');
        $lastname = $request->query('lastname');
        $category = $request->query('category');

        $zip = $this->documentService->buildZip($name, $lastname, $category);

        if (! $zip) {
            return response()->json(['message' => 'No matching files found'], 404);
        }

        $asciiFilename = preg_replace('/[^\x20-\x7E]/', '_', $zip['filename']);
        $encodedName   = rawurlencode($zip['filename']);
        $contentDisp   = "attachment; filename=\"{$asciiFilename}\"; filename*=UTF-8''{$encodedName}";

        return response($zip['data'], 200, [
            'Content-Type'        => 'application/zip',
            'Content-Disposition' => $contentDisp,
            'Content-Length'      => strlen($zip['data']),
        ]);
    }

    // -------------------------------------------------------------------------
    // DELETE /api/files/{id}
    // -------------------------------------------------------------------------

    public function destroy(Request $request, string $id): JsonResponse
    {
        $name     = $request->query('name');
        $lastname = $request->query('lastname');

        if (! $name || ! $lastname) {
            return response()->json(['message' => 'Access denied'], 403);
        }

        $result = $this->documentService->deleteFile($id, $name, $lastname);

        if ($result === null) {
            return response()->json(['message' => 'File not found'], 404);
        }

        return response()->json($result);
    }
}

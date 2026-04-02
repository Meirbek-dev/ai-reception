<?php

namespace App\Services;

use App\Jobs\ProcessUploadedDocument;
use App\Models\Document;
use App\Models\DocumentText;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class DocumentService
{
    private OcrService $ocr;
    private ClassifierService $classifier;
    private string $uploadDir;

    public function __construct(OcrService $ocr, ClassifierService $classifier)
    {
        $this->ocr        = $ocr;
        $this->classifier = $classifier;
        $this->uploadDir  = storage_path('app/uploads');
    }

    // -------------------------------------------------------------------------
    // Upload processing
    // -------------------------------------------------------------------------

    /**
     * Queue a single uploaded file for asynchronous OCR/classification.
     */
    public function queueFile(UploadedFile $file, string $name, string $lastname): array
    {
        $fileId       = (string) Str::uuid();
        $originalName = $file->getClientOriginalName();
        $ext          = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        $pendingRel   = 'uploads/pending/'.$fileId.($ext !== '' ? '.'.$ext : '');
        $pendingPath  = $this->absoluteStoragePath($pendingRel);
        $size         = (int) ($file->getSize() ?? 0);

        $this->ensureDirectory(dirname($pendingPath));

        if (! $this->moveProcessedFile((string) $file->getRealPath(), $pendingPath)) {
            return $this->buildClientPayload(
                $fileId,
                $originalName,
                'Unclassified',
                '',
                $size,
                time(),
                'failed',
                0.0,
                null,
                'failed to persist uploaded file'
            );
        }

        $document = Document::create([
            'id'                           => $fileId,
            'original_name'                => $originalName,
            'stored_filename'              => null,
            'processing_path'              => $pendingRel,
            'processing_error'             => null,
            'applicant_name'               => $name,
            'applicant_name_normalized'    => $this->normalizeApplicantLookup($name),
            'applicant_lastname'           => $lastname,
            'applicant_lastname_normalized'=> $this->normalizeApplicantLookup($lastname),
            'category_predicted'           => 'Unclassified',
            'category_confidence'          => 0.0,
            'category_final'               => null,
            'status'                       => 'uploaded',
            'processing_state'             => 'processing',
            'size_bytes'                   => $size,
        ]);

        ProcessUploadedDocument::dispatch($document->id);

        return $this->payloadFromDocument($document->fresh());
    }

    public function processQueuedDocument(string $documentId): void
    {
        /** @var Document|null $document */
        $document = Document::query()->find($documentId);

        if (! $document || ! $document->processing_path) {
            return;
        }

        $pendingPath = $this->absoluteStoragePath($document->processing_path);
        if (! is_file($pendingPath)) {
            $this->markProcessingFailure($document, 'pending upload file is missing');
            return;
        }

        $ext = strtolower(pathinfo($document->original_name, PATHINFO_EXTENSION));

        try {
            $text   = $this->ocr->extractText($pendingPath, $ext);
            $result = $this->classifier->classify($text);

            $this->persistExtractedText($document->id, $text);

            $category   = $result['category'];
            $confidence = (float) $result['confidence'];
            $status     = $this->classifier->determineStatus($confidence);

            if ($category === 'Unclassified') {
                @unlink($pendingPath);

                $document->update([
                    'processing_path'     => null,
                    'processing_state'    => 'unclassified',
                    'processing_error'    => null,
                    'stored_filename'     => null,
                    'category_predicted'  => 'Unclassified',
                    'category_confidence' => 0.0,
                    'updated_at'          => now(),
                ]);

                return;
            }

            [$storedName, $destination] = $this->allocateStoredFilename(
                $document->id,
                $document->applicant_name,
                $document->applicant_lastname,
                $category,
                $ext
            );

            if (! $this->moveProcessedFile($pendingPath, $destination)) {
                $this->markProcessingFailure($document, 'failed to move processed file to final storage');
                return;
            }

            $document->update([
                'stored_filename'     => 'uploads/'.$storedName,
                'processing_path'     => null,
                'processing_state'    => null,
                'processing_error'    => null,
                'category_predicted'  => $category,
                'category_confidence' => $confidence,
                'status'              => $status,
                'updated_at'          => now(),
            ]);
        } catch (\Throwable $e) {
            Log::error('Queued document processing failed: '.$e->getMessage(), [
                'document_id' => $documentId,
            ]);

            $this->markProcessingFailure($document, $e->getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // File listing helpers
    // -------------------------------------------------------------------------

    /**
     * List files matching applicant ownership using database-backed lookups.
     */
    public function listFiles(?string $category, ?string $name, ?string $lastname): array
    {
        if (! $name || ! $lastname) {
            return [];
        }

        $query = $this->baseApplicantQuery($name, $lastname)
            ->orderByDesc('created_at');

        if ($category) {
            $query->where(function ($builder) use ($category) {
                $builder->where('category_final', $category)
                    ->orWhere(function ($inner) use ($category) {
                        $inner->whereNull('category_final')
                            ->where('category_predicted', $category);
                    });
            });
        }

        return $query
            ->get()
            ->map(fn (Document $document) => $this->payloadFromDocument($document))
            ->all();
    }

    /**
     * Find a file by UUID id and validate name/lastname ownership.
     */
    public function findFile(string $fileId, ?string $name, ?string $lastname): ?array
    {
        if (! $name || ! $lastname) {
            return null;
        }

        $document = $this->findApplicantDocument($fileId, $name, $lastname);
        if (! $document || ! $document->stored_filename) {
            return null;
        }

        $path = $this->absoluteStoragePath($document->stored_filename);
        if (! is_file($path)) {
            return null;
        }

        return [
            'path' => $path,
            'filename' => basename($document->stored_filename),
            'document' => $document,
        ];
    }

    /**
     * Delete a file by UUID id after validating ownership.
     */
    public function deleteFile(string $fileId, ?string $name, ?string $lastname): ?array
    {
        $document = $this->findApplicantDocument($fileId, $name, $lastname);
        if (! $document) {
            return null;
        }

        $storedPath = $document->stored_filename
            ? $this->absoluteStoragePath($document->stored_filename)
            : null;
        $pendingPath = $document->processing_path
            ? $this->absoluteStoragePath($document->processing_path)
            : null;

        $stat = $storedPath && is_file($storedPath) ? stat($storedPath) : null;

        if ($storedPath && is_file($storedPath)) {
            @unlink($storedPath);
        }

        if ($pendingPath && is_file($pendingPath)) {
            @unlink($pendingPath);
        }

        $payload = $this->payloadFromDocument($document);
        $document->delete();

        return [
            'status'        => 'deleted',
            'filename'      => $payload['filename'],
            'id'            => $document->id,
            'original_name' => $document->original_name,
            'category'      => $document->effectiveCategory(),
            'size'          => $stat ? $stat['size'] : null,
            'modified'      => $stat ? $stat['mtime'] : null,
        ];
    }

    /**
     * Build a ZIP archive for all matching files and return a temp path.
     */
    public function buildZipArchive(string $name, string $lastname, ?string $category): ?array
    {
        $matching = $this->baseApplicantQuery($name, $lastname)
            ->whereNotNull('stored_filename')
            ->whereNull('processing_state');

        if ($category) {
            $matching->where(function ($builder) use ($category) {
                $builder->where('category_final', $category)
                    ->orWhere(function ($inner) use ($category) {
                        $inner->whereNull('category_final')
                            ->where('category_predicted', $category);
                    });
            });
        }

        $documents = $matching->get();

        if ($documents->isEmpty()) {
            return null;
        }

        $tmpZip = tempnam(sys_get_temp_dir(), 'zip_');
        $zip    = new \ZipArchive();
        if ($zip->open($tmpZip, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            return null;
        }

        foreach ($documents as $document) {
            $path = $this->absoluteStoragePath((string) $document->stored_filename);
            if (is_file($path)) {
                $zip->addFile($path, basename((string) $document->stored_filename));
            }
        }

        $zip->close();

        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);

        return [
            'path'     => $tmpZip,
            'filename' => "{$safeName}_{$safeLastname}_documents.zip",
        ];
    }

    // -------------------------------------------------------------------------
    // Filename parsing
    // -------------------------------------------------------------------------

    /**
     * Parse stored filename: {name}_{lastname}_{category}_{idx}_{uuid}.{ext}
     *
     * Returns ['id', 'category', 'name', 'original'] or null.
     * Mirrors parse_stored_filename() from Python.
     */
    public function parseStoredFilename(string $filename): ?array
    {
        $stem   = pathinfo($filename, PATHINFO_FILENAME);
        $tokens = explode('_', $stem);

        // Find UUID position
        $uuidPattern = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';
        $uuidPos     = null;
        $fileId      = null;

        foreach ($tokens as $i => $token) {
            if (preg_match($uuidPattern, $token)) {
                $uuidPos = $i;
                $fileId  = $token;
                break;
            }
        }

        if ($uuidPos === null || $uuidPos < 3) {
            return null;
        }

        // tokens[uuid_pos - 2] = category, tokens[uuid_pos - 1] = idx
        $categoryToken = $tokens[$uuidPos - 2];

        // Validate category
        $validCategories = ['Udostoverenie', 'ENT', 'Lgota', 'Diplom', 'Privivka', 'MedSpravka'];
        $canonical       = null;
        foreach ($validCategories as $cat) {
            if (strtolower($cat) === strtolower($categoryToken)) {
                $canonical = $cat;
                break;
            }
        }

        if ($canonical === null) {
            return null;
        }

        // Everything before category and idx is name+lastname
        $leading = array_slice($tokens, 0, $uuidPos - 2);
        if (count($leading) < 2) {
            return null;
        }

        $namePart     = $leading[0];
        $lastnamePart = implode('_', array_slice($leading, 1));
        $fullName     = "{$namePart}_{$lastnamePart}";

        return [
            'id'       => $fileId,
            'category' => $canonical,
            'name'     => $fullName,
            'original' => $fullName,
        ];
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    public function sanitizeName(string $name, int $maxLen = 50): string
    {
        if ($name === '') {
            return 'anon';
        }

        $safe = '';
        foreach (mb_str_split($name) as $c) {
            $safe .= (ctype_alnum($c) || $c === '-') ? $c : '_';
        }

        // Collapse consecutive underscores
        $safe = preg_replace('/_+/', '_', $safe);
        $safe = trim($safe, '_');
        $safe = mb_substr($safe, 0, $maxLen);

        return $safe !== '' ? $safe : 'anon';
    }

    public function normalizeApplicantLookup(string $value): string
    {
        $normalized = mb_strtolower(trim($value));
        $normalized = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $normalized) ?? '';

        return trim($normalized);
    }

    private function persistExtractedText(string $documentId, string $text): void
    {
        DocumentText::updateOrCreate(
            ['document_id' => $documentId],
            [
                'text_excerpt' => $text !== '' ? mb_substr($text, 0, 5000) : null,
                'created_at' => now(),
            ]
        );
    }

    private function allocateStoredFilename(
        string $fileId,
        string $name,
        string $lastname,
        string $category,
        string $ext
    ): array {
        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);

        $this->ensureDirectory($this->uploadDir);

        for ($idx = 1; $idx <= 100; $idx++) {
            $candidate = "{$safeName}_{$safeLastname}_{$category}_{$idx}_{$fileId}";
            if ($ext !== '') {
                $candidate .= '.'.$ext;
            }

            $destination = $this->uploadDir.'/'.$candidate;
            if (! file_exists($destination)) {
                return [$candidate, $destination];
            }
        }

        throw new \RuntimeException('too many filename collisions');
    }

    private function baseApplicantQuery(string $name, string $lastname)
    {
        return Document::query()
            ->where('applicant_name_normalized', $this->normalizeApplicantLookup($name))
            ->where('applicant_lastname_normalized', $this->normalizeApplicantLookup($lastname));
    }

    private function findApplicantDocument(string $fileId, string $name, string $lastname): ?Document
    {
        /** @var Document|null $document */
        $document = $this->baseApplicantQuery($name, $lastname)
            ->where('id', $fileId)
            ->first();

        return $document;
    }

    private function payloadFromDocument(Document $document): array
    {
        return $this->buildClientPayload(
            $document->id,
            $document->original_name,
            $document->effectiveCategory(),
            $document->stored_filename ? basename($document->stored_filename) : '',
            (int) ($document->size_bytes ?? 0),
            $document->updated_at?->timestamp ?? $document->created_at?->timestamp ?? time(),
            $document->effectiveStatus(),
            (float) $document->category_confidence,
            $document->id,
            $document->processing_error,
        );
    }

    private function markProcessingFailure(Document $document, string $error): void
    {
        $document->update([
            'processing_state' => 'failed',
            'processing_error' => Str::limit($error, 1000, ''),
            'updated_at' => now(),
        ]);
    }

    private function absoluteStoragePath(string $relativePath): string
    {
        return storage_path('app/'.$relativePath);
    }

    private function ensureDirectory(string $path): void
    {
        if (! is_dir($path)) {
            mkdir($path, 0755, true);
        }
    }

    private function moveProcessedFile(string $source, string $destination): bool
    {
        if (! is_file($source)) {
            return false;
        }

        $this->ensureDirectory(dirname($destination));

        if (@rename($source, $destination)) {
            return true;
        }

        if (! @copy($source, $destination)) {
            return false;
        }

        @unlink($source);

        return true;
    }

    private function buildClientPayload(
        string $id,
        string $originalName,
        string $category,
        string $filename,
        int $size,
        int $modified,
        string $status,
        float $confidence,
        ?string $dbId,
        ?string $error = null
    ): array {
        return [
            'id'           => $id,
            'originalName' => $originalName,
            'newName'      => $filename ?: null,
            'filename'     => $filename ?: null,
            'category'     => $category,
            'size'         => $size,
            'modified'     => $modified,
            'status'       => $status,
            'confidence'   => $confidence,
            'dbId'         => $dbId,
            'error'        => $error,
            'uid'          => $id,
        ];
    }
}

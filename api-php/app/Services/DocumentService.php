<?php

namespace App\Services;

use App\Models\Document;
use App\Models\DocumentText;
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
     * Process a single uploaded file: OCR → classify → persist → move to storage.
     * Returns a client-facing array (matches processed_file_to_client() from Python).
     */
    public function processFile(
        string $tmpPath,
        string $originalName,
        string $name,
        string $lastname
    ): array {
        $ext      = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        $fileId   = (string) Str::uuid();
        $size     = filesize($tmpPath);
        $modified = time();

        // OCR
        $text   = $this->ocr->extractText($tmpPath);
        $result = $this->classifier->classify($text);

        $category   = $result['category'];
        $confidence = $result['confidence'];
        $fuzzyScore = $result['fuzzy_score'];
        $status     = $this->classifier->determineStatus($confidence);

        if ($category === 'Unclassified') {
            @unlink($tmpPath);
            return $this->buildClientPayload(
                $fileId, $originalName, $category, '', $size, $modified, 'unclassified', $confidence, null
            );
        }

        // Build filename: {name}_{lastname}_{category}_{idx}_{uuid}.{ext}
        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);
        $storedName   = null;
        $destPath     = null;

        if (! is_dir($this->uploadDir)) {
            mkdir($this->uploadDir, 0755, true);
        }

        for ($idx = 1; $idx <= 100; $idx++) {
            $candidate = "{$safeName}_{$safeLastname}_{$category}_{$idx}_{$fileId}.{$ext}";
            $dest      = $this->uploadDir.'/'.$candidate;
            if (! file_exists($dest)) {
                if (! $this->moveProcessedFile($tmpPath, $dest)) {
                    return $this->buildClientPayload(
                        $fileId,
                        $originalName,
                        $category,
                        '',
                        $size,
                        $modified,
                        'error: failed to persist uploaded file',
                        $confidence,
                        null
                    );
                }
                $storedName = $candidate;
                $destPath   = $dest;
                break;
            }
        }

        if ($storedName === null) {
            @unlink($tmpPath);
            return $this->buildClientPayload(
                $fileId, $originalName, $category, '', $size, $modified,
                'error: too many collisions', $confidence, null
            );
        }

        // Persist to database (stored_filename relative to storage root)
        $relPath = 'uploads/'.$storedName;
        $dbId    = null;

        try {
            $doc = Document::create([
                'id'                  => $fileId,
                'original_name'       => $originalName,
                'stored_filename'     => $relPath,
                'applicant_name'      => $name,
                'applicant_lastname'  => $lastname,
                'category_predicted'  => $category,
                'category_confidence' => $confidence,
                'status'              => $status,
                'size_bytes'          => $size,
            ]);

            if ($text !== '') {
                DocumentText::create([
                    'document_id'  => $doc->id,
                    'text_excerpt' => mb_substr($text, 0, 5000),
                    'created_at'   => now(),
                ]);
            }

            $dbId = $doc->id;
        } catch (\Throwable $e) {
            \Illuminate\Support\Facades\Log::error('Failed to persist document: '.$e->getMessage());
            // Don't fail the upload, file is already saved
        }

        return $this->buildClientPayload(
            $fileId, $originalName, $category, $storedName, $size, $modified, 'saved', $confidence, $dbId
        );
    }

    // -------------------------------------------------------------------------
    // File listing helpers
    // -------------------------------------------------------------------------

    /**
     * List files in the upload directory matching name+lastname (required for privacy).
     * Mirrors _list_files_sync() from Python.
     */
    public function listFiles(?string $category, ?string $name, ?string $lastname): array
    {
        if (! $name || ! $lastname) {
            return [];
        }

        if (! is_dir($this->uploadDir)) {
            return [];
        }

        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);
        $expected     = strtolower("{$safeName}_{$safeLastname}");

        $results = [];
        foreach (new \DirectoryIterator($this->uploadDir) as $f) {
            if (! $f->isFile()) {
                continue;
            }
            $meta = $this->parseStoredFilename($f->getFilename());
            if (! $meta) {
                continue;
            }
            if (strtolower($meta['name']) !== $expected) {
                continue;
            }
            if ($category && $meta['category'] !== $category) {
                continue;
            }
            $results[] = $this->buildClientPayload(
                $meta['id'], $meta['original'], $meta['category'],
                $f->getFilename(), $f->getSize(), $f->getMTime(), 'saved', 0.0, null
            );
        }

        return $results;
    }

    /**
     * Find a file by UUID id and validate name/lastname ownership.
     * Returns ['path' => string, 'filename' => string] or null.
     */
    public function findFile(string $fileId, ?string $name, ?string $lastname): ?array
    {
        if (! $name || ! $lastname) {
            return null;
        }

        if (! is_dir($this->uploadDir)) {
            return null;
        }

        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);
        $expected     = strtolower("{$safeName}_{$safeLastname}");

        foreach (new \DirectoryIterator($this->uploadDir) as $f) {
            if (! $f->isFile()) {
                continue;
            }
            $meta = $this->parseStoredFilename($f->getFilename());
            if (! $meta || $meta['id'] !== $fileId) {
                continue;
            }
            if (strtolower($meta['name']) !== $expected) {
                return null; // file exists but doesn't belong to this user — deny
            }
            return ['path' => $f->getPathname(), 'filename' => $f->getFilename()];
        }

        return null;
    }

    /**
     * Delete a file by UUID id after validating ownership.
     */
    public function deleteFile(string $fileId, ?string $name, ?string $lastname): ?array
    {
        $found = $this->findFile($fileId, $name, $lastname);
        if (! $found) {
            return null;
        }

        $meta = $this->parseStoredFilename($found['filename']);
        $stat = stat($found['path']);

        @unlink($found['path']);

        return [
            'status'        => 'deleted',
            'filename'      => $found['filename'],
            'id'            => $meta['id'] ?? $fileId,
            'original_name' => $meta['original'] ?? null,
            'category'      => $meta['category'] ?? null,
            'size'          => $stat ? $stat['size'] : null,
            'modified'      => $stat ? $stat['mtime'] : null,
        ];
    }

    /**
     * Build a ZIP archive of all matching files in memory.
     * Returns ['data' => string, 'filename' => string] or null.
     */
    public function buildZip(string $name, string $lastname, ?string $category): ?array
    {
        if (! is_dir($this->uploadDir)) {
            return null;
        }

        $safeName     = $this->sanitizeName($name);
        $safeLastname = $this->sanitizeName($lastname);
        $expected     = strtolower("{$safeName}_{$safeLastname}");

        $matching = [];
        foreach (new \DirectoryIterator($this->uploadDir) as $f) {
            if (! $f->isFile()) {
                continue;
            }
            $meta = $this->parseStoredFilename($f->getFilename());
            if (! $meta) {
                continue;
            }
            if (strtolower($meta['name']) !== $expected) {
                continue;
            }
            if ($category && $meta['category'] !== $category) {
                continue;
            }
            $matching[] = $f->getPathname();
        }

        if (empty($matching)) {
            return null;
        }

        $tmpZip = tempnam(sys_get_temp_dir(), 'zip_');
        $zip    = new \ZipArchive();
        if ($zip->open($tmpZip, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            return null;
        }
        foreach ($matching as $path) {
            $zip->addFile($path, basename($path));
        }
        $zip->close();

        $data    = file_get_contents($tmpZip);
        @unlink($tmpZip);

        return [
            'data'     => $data,
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

    private function moveProcessedFile(string $source, string $destination): bool
    {
        if (! is_file($source)) {
            return false;
        }

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
        ?string $dbId
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
            'uid'          => $id,
        ];
    }
}

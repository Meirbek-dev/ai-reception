<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Intervention\Image\Drivers\Gd\Driver;
use Intervention\Image\ImageManager;
use thiagoalessio\TesseractOCR\TesseractOCR;

class OcrService
{
    private int $maxPagesOcr;
    private int $pdfDpi;
    private int $imageMaxSize;
    private int $tesseractPsm;
    private int $tesseractTimeout;
    private int $maxTextLength;
    private int $cacheTtlDays;
    private string $cacheDir;

    public function __construct()
    {
        $this->maxPagesOcr      = (int) config('app.max_pages_ocr', 10);
        $this->pdfDpi           = (int) config('app.pdf_dpi', 200);
        $this->imageMaxSize     = (int) config('app.image_max_size', 1800);
        $this->tesseractPsm     = (int) config('app.tesseract_psm', 4);
        $this->tesseractTimeout = (int) config('app.tesseract_timeout', 60);
        $this->maxTextLength    = (int) config('app.max_text_extract_length', 5000);
        $this->cacheTtlDays     = (int) config('app.cache_ttl_days', 7);
        $this->cacheDir         = storage_path('app/cache');
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Extract text from a file path.
     * Checks the SHA-256 cache first; performs OCR on a cache miss.
     *
     * @param string $filePath    Path to the file (may be a generic PHP temp path with no useful extension)
     * @param string $hintExt     Original file extension hint (e.g. 'pdf', 'jpg') — used when the temp
     *                            path extension is not a recognised image/PDF type.
     */
    public function extractText(string $filePath, string $hintExt = ''): string
    {
        $hash   = $this->cacheKey($filePath);
        $cached = $this->readCache($hash);

        if ($cached !== null) {
            Log::info("OCR cache hit: {$hash}");
            return $cached;
        }

        // Prefer the path's own extension; fall back to the caller-supplied hint.
        // PHP uploaded temp files use .tmp on Windows, so the hint is critical.
        $pathExt = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
        $ext     = in_array($pathExt, ['pdf', 'jpg', 'jpeg', 'png'], true)
            ? $pathExt
            : strtolower(ltrim($hintExt, '.'));

        $text = match ($ext) {
            'pdf'         => $this->extractFromPdf($filePath),
            'jpg', 'jpeg',
            'png'         => $this->extractFromImage($filePath),
            default       => '',
        };

        if ($text === '') {
            Log::warning("OCR returned empty text for: {$filePath} (ext={$ext})");
        } else {
            Log::info("OCR extracted " . mb_strlen($text) . " chars from: {$filePath} (ext={$ext})");
        }

        $this->writeCache($hash, $text);
        return $text;
    }

    // -------------------------------------------------------------------------
    // OCR internals
    // -------------------------------------------------------------------------

    private function extractFromPdf(string $filePath): string
    {
        $tmpPrefix = tempnam(sys_get_temp_dir(), 'pdf_ocr_');
        @unlink($tmpPrefix); // pdftoppm adds extensions itself

        $lastPage = $this->maxPagesOcr;
        $dpi      = $this->pdfDpi;

        // Convert PDF pages to PNG images via pdftoppm (poppler)
        $cmd    = sprintf(
            'pdftoppm -r %d -png -l %d %s %s 2>&1',
            $dpi,
            $lastPage,
            escapeshellarg($filePath),
            escapeshellarg($tmpPrefix)
        );
        exec($cmd, $output, $exitCode);

        $images = glob($tmpPrefix.'-*.png') ?: glob($tmpPrefix.'*.png') ?: [];

        if (empty($images)) {
            Log::warning("pdftoppm produced no images for: {$filePath}. Output: ".implode("\n", $output));
            return '';
        }

        sort($images); // ensure page order

        $texts = [];
        foreach ($images as $imgPath) {
            $texts[] = $this->ocrImageFile($imgPath);
            @unlink($imgPath);
        }

        $combined = implode("\n", array_filter($texts));
        return mb_substr($combined, 0, $this->maxTextLength);
    }

    private function extractFromImage(string $filePath): string
    {
        $preprocessed = $this->preprocessImage($filePath);
        $text         = $this->ocrImageFile($preprocessed);
        if ($preprocessed !== $filePath) {
            @unlink($preprocessed);
        }
        return mb_substr($text, 0, $this->maxTextLength);
    }

    /**
     * Run Tesseract on a single image file.
     */
    private function ocrImageFile(string $imagePath): string
    {
        try {
            return (new TesseractOCR($imagePath))
                ->lang('rus', 'eng')
                ->psm($this->tesseractPsm)
                ->run();
        } catch (\Throwable $e) {
            Log::warning("Tesseract failed for {$imagePath}: {$e->getMessage()}");
            return '';
        }
    }

    /**
     * Preprocess image: convert to greyscale + resize to max dimension.
     * Returns path to preprocessed temp file (or original if unchanged).
     */
    private function preprocessImage(string $filePath): string
    {
        try {
            $manager = new ImageManager(new Driver());
            // Intervention Image v4 uses decodePath(); v3 used read().
            $img = $manager->read($filePath);

            $img->greyscale();

            $w = $img->width();
            $h = $img->height();
            if (max($w, $h) > $this->imageMaxSize) {
                $img->scaleDown($this->imageMaxSize, $this->imageMaxSize);
            }

            // tempnam creates the placeholder file; append .png for the actual output.
            $placeholder = tempnam(sys_get_temp_dir(), 'ocr_img_');
            $tmp         = $placeholder . '.png';
            @unlink($placeholder); // remove the placeholder; we'll write to $tmp
            $img->save($tmp);
            return $tmp;
        } catch (\Throwable $e) {
            Log::warning("Image preprocessing failed: {$e->getMessage()}");
            return $filePath; // fall back to original
        }
    }

    // -------------------------------------------------------------------------
    // Cache helpers  (SHA-256 keyed JSON files)
    // -------------------------------------------------------------------------

    private function cacheKey(string $filePath): string
    {
        return hash_file('sha256', $filePath);
    }

    private function cachePath(string $hash): string
    {
        $subdir = substr($hash, 0, 2);
        return $this->cacheDir."/{$subdir}/{$hash}.json";
    }

    private function readCache(string $hash): ?string
    {
        $path = $this->cachePath($hash);
        if (! file_exists($path)) {
            return null;
        }

        // Expire check
        $age = (time() - filemtime($path)) / 86400;
        if ($age > $this->cacheTtlDays) {
            @unlink($path);
            return null;
        }

        $data = json_decode(file_get_contents($path), true);
        return isset($data['text']) ? (string) $data['text'] : null;
    }

    private function writeCache(string $hash, string $text): void
    {
        $path = $this->cachePath($hash);
        $dir  = dirname($path);
        if (! is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        file_put_contents($path, json_encode([
            'text'      => $text,
            'timestamp' => time(),
        ], JSON_UNESCAPED_UNICODE));
    }
}

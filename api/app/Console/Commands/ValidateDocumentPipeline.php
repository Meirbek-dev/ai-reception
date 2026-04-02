<?php

namespace App\Console\Commands;

use App\Services\ClassifierService;
use App\Services\OcrService;
use Illuminate\Console\Command;

class ValidateDocumentPipeline extends Command
{
    protected $signature = 'documents:validate-pipeline
                            {manifest=tests/Fixtures/validation/manifest.example.json : JSON manifest describing validation documents}';

    protected $description = 'Run OCR and classification against a validation manifest to benchmark accuracy before tuning';

    public function handle(OcrService $ocrService, ClassifierService $classifierService): int
    {
        $manifestPath = base_path((string) $this->argument('manifest'));
        if (! is_file($manifestPath)) {
            $this->error("Manifest not found: {$manifestPath}");
            return self::FAILURE;
        }

        $manifest = json_decode((string) file_get_contents($manifestPath), true);
        if (! is_array($manifest) || ! isset($manifest['documents']) || ! is_array($manifest['documents'])) {
            $this->error('Manifest must contain a top-level "documents" array.');
            return self::FAILURE;
        }

        $rows          = [];
        $total         = 0;
        $correct       = 0;
        $missingFiles  = 0;

        foreach ($manifest['documents'] as $entry) {
            if (! is_array($entry)) {
                continue;
            }

            $relativePath = (string) ($entry['path'] ?? '');
            $expected     = (string) ($entry['expected_category'] ?? '');
            if ($relativePath === '' || $expected === '') {
                continue;
            }

            $absolutePath = base_path($relativePath);
            $total++;

            if (! is_file($absolutePath)) {
                $missingFiles++;
                $rows[] = [
                    'file' => $relativePath,
                    'expected' => $expected,
                    'actual' => 'MISSING',
                    'confidence' => '-',
                    'result' => 'missing',
                ];
                continue;
            }

            $ext = strtolower(pathinfo($absolutePath, PATHINFO_EXTENSION));
            $text = $ocrService->extractText($absolutePath, $ext);
            $classification = $classifierService->classify($text);
            $actual = (string) ($classification['category'] ?? 'Unclassified');
            $confidence = number_format((float) ($classification['confidence'] ?? 0), 3);
            $matched = $actual === $expected;

            if ($matched) {
                $correct++;
            }

            $rows[] = [
                'file' => $relativePath,
                'expected' => $expected,
                'actual' => $actual,
                'confidence' => $confidence,
                'result' => $matched ? 'ok' : 'mismatch',
            ];
        }

        $this->table(['file', 'expected', 'actual', 'confidence', 'result'], $rows);

        $evaluated = max($total - $missingFiles, 0);
        $accuracy = $evaluated > 0 ? round(($correct / $evaluated) * 100, 2) : 0.0;

        $this->newLine();
        $this->info("Evaluated: {$evaluated}");
        $this->info("Correct: {$correct}");
        $this->info("Missing: {$missingFiles}");
        $this->info("Accuracy: {$accuracy}%");

        return self::SUCCESS;
    }
}

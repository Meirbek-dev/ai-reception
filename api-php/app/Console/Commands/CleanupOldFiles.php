<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;

class CleanupOldFiles extends Command
{
    protected $signature   = 'app:cleanup-old-files';
    protected $description = 'Remove uploaded files older than MAX_FILE_AGE_DAYS and expired OCR cache entries';

    public function handle(): int
    {
        $removedFiles = $this->cleanUploads();
        $removedCache = $this->cleanCache();

        $this->info("Cleanup complete: removed {$removedFiles} upload(s), {$removedCache} cache entry(ies).");

        return self::SUCCESS;
    }

    private function cleanUploads(): int
    {
        $dir     = storage_path('app/uploads');
        $maxDays = (int) config('app.max_file_age_days', 30);
        $cutoff  = time() - $maxDays * 86400;
        $removed = 0;

        if (! is_dir($dir)) {
            return 0;
        }

        foreach (new \DirectoryIterator($dir) as $f) {
            if (! $f->isFile()) {
                continue;
            }
            if ($f->getMTime() < $cutoff) {
                @unlink($f->getPathname());
                $removed++;
                $this->line("Removed old upload: {$f->getFilename()}");
            }
        }

        return $removed;
    }

    private function cleanCache(): int
    {
        $dir     = storage_path('app/cache');
        $ttlDays = (int) config('app.cache_ttl_days', 7);
        $cutoff  = time() - $ttlDays * 86400;
        $removed = 0;

        if (! is_dir($dir)) {
            return 0;
        }

        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS)) as $f) {
            if (! $f->isFile() || $f->getExtension() !== 'json') {
                continue;
            }
            if ($f->getMTime() < $cutoff) {
                @unlink($f->getPathname());
                $removed++;
            }
        }

        // Remove empty subdirectories
        foreach (new \DirectoryIterator($dir) as $subdir) {
            if ($subdir->isDir() && ! $subdir->isDot()) {
                $iter = new \FilesystemIterator($subdir->getPathname());
                if (! $iter->valid()) {
                    @rmdir($subdir->getPathname());
                }
            }
        }

        return $removed;
    }
}

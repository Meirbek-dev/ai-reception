<?php

namespace App\Http\Middleware;

use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;

/**
 * Extend the default CSRF middleware to exclude public file-management endpoints.
 * These routes are unauthenticated, so CSRF protection is not needed there.
 * Sanctum's EnsureFrontendRequestsAreStateful resolves this class via
 * config('sanctum.middleware.verify_csrf_token').
 */
class VerifyCsrfToken extends PreventRequestForgery
{
    /**
     * URIs that should be excluded from CSRF verification.
     */
    protected $except = [
        '/upload',
        '/files',
        '/files/*',
        '/download_zip',
        '/health',
        '/auth/login',
        '/up',
    ];
}

<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        // Rate limiter for the /api/upload endpoint.
        // Mirrors Python's in-memory RateLimiter (30 req/min per IP by default).
        RateLimiter::for('upload', function (Request $request) {
            return Limit::perMinute(config('app.rate_limit_per_minute', 30))
                        ->by($request->ip())
                        ->response(function () {
                            return response()->json(
                                ['message' => 'Rate limit exceeded. Please try again later.'],
                                429
                            );
                        });
        });
    }
}

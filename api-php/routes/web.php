<?php

use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| SPA Fallback
|--------------------------------------------------------------------------
|
| All non-API routes return the React SPA's index.html so that
| TanStack Router can handle client-side navigation.
| The built frontend assets are in public/build (copied by Dockerfile).
|
*/

Route::get('/{any?}', function () {
    $buildIndex = public_path('build/index.html');

    if (file_exists($buildIndex)) {
        return response()->file($buildIndex);
    }

    return response()->json(['message' => 'Frontend not built'], 404);
})->where('any', '^(?!api).*$');

<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class RequireRole
{
    /**
     * Handle an incoming request.
     *
     * Usage: ->middleware('auth:sanctum', 'role:reviewer,admin')
     */
    public function handle(Request $request, Closure $next, string ...$roles): Response
    {
        $user = $request->user();

        if (! $user) {
            return response()->json(['message' => 'Не выполнен вход'], 401);
        }

        if (! $user->is_active) {
            return response()->json(['message' => 'Учётная запись пользователя отключена'], 403);
        }

        if (! in_array($user->role, $roles, true)) {
            return response()->json([
                'message' => 'Требуется одна из ролей: '.implode(', ', $roles),
            ], 403);
        }

        return $next($request);
    }
}

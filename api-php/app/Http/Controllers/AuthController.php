<?php

namespace App\Http\Controllers;

use App\Http\Resources\UserResource;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    /**
     * POST /api/auth/login
     *
     * Authenticates user and starts a session.
     * Returns user info + session metadata.
     */
    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email'       => 'required|email',
            'password'    => 'required|string',
            'remember_me' => 'boolean',
        ]);

        $email    = strtolower(trim($data['email']));
        $remember = (bool) ($data['remember_me'] ?? false);

        /** @var User|null $user */
        $user = User::where('email', $email)->first();

        if (! $user || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['Неверный email или пароль'],
            ])->status(401);
        }

        if (! $user->is_active) {
            return response()->json(['message' => 'Учётная запись отключена'], 403);
        }

        Auth::login($user, $remember);

        $user->update(['last_login_at' => now()]);

        $session = $request->session();
        $expiresAt = $remember
            ? now()->addDays(30)
            : now()->addDay();

        return response()->json([
            'message' => 'Успешный вход',
            'user'    => new UserResource($user),
            'session' => [
                'expires_at'  => $expiresAt->toIso8601String(),
                'remember_me' => $remember,
            ],
        ]);
    }

    /**
     * POST /api/auth/logout
     */
    public function logout(Request $request): JsonResponse
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['message' => 'Вы успешно вышли']);
    }

    /**
     * POST /api/auth/refresh
     *
     * Refreshes the session and returns current user + session info.
     */
    public function refresh(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        $request->session()->regenerate();

        return response()->json([
            'message' => 'Сессия обновлена',
            'user'    => new UserResource($user),
            'session' => [
                'expires_at'  => now()->addMinutes(config('session.lifetime'))->toIso8601String(),
                'remember_me' => false,
            ],
        ]);
    }

    /**
     * GET /api/auth/me
     */
    public function me(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return response()->json([
            'user'    => new UserResource($user),
            'session' => [
                'expires_at'  => now()->addMinutes(config('session.lifetime'))->toIso8601String(),
                'remember_me' => false,
            ],
        ]);
    }
}

<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id'            => $this->id,
            'email'         => $this->email,
            'display_name'  => $this->display_name,
            'role'          => $this->role,
            'is_active'     => $this->is_active,
            'last_login_at' => $this->last_login_at?->toIso8601String(),
        ];
    }
}

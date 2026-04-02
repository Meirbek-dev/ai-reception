<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

class CreateAdminUser extends Command
{
    protected $signature   = 'admin:create
                                {--email= : User email address}
                                {--name=  : Display name}
                                {--password= : Password (prompted if omitted)}
                                {--role=admin : Role (reviewer|admin)}';

    protected $description = 'Create an admin or reviewer user (mirrors manage.py create-admin)';

    public function handle(): int
    {
        $email    = $this->option('email') ?? $this->ask('Email address');
        $name     = $this->option('name') ?? $this->ask('Display name', $email);
        $role     = $this->option('role') ?? 'admin';
        $password = $this->option('password') ?? $this->secret('Password');

        if (! in_array($role, ['reviewer', 'admin'], true)) {
            $this->error("Invalid role '{$role}'. Must be 'reviewer' or 'admin'.");
            return self::FAILURE;
        }

        if (User::where('email', strtolower($email))->exists()) {
            $this->error("User with email {$email} already exists.");
            return self::FAILURE;
        }

        $user = User::create([
            'id'           => (string) Str::uuid(),
            'email'        => strtolower(trim($email)),
            'display_name' => $name,
            'role'         => $role,
            'password'     => Hash::make($password),
            'is_active'    => true,
        ]);

        $this->info("Created {$role} user: {$user->email} (id: {$user->id})");

        return self::SUCCESS;
    }
}

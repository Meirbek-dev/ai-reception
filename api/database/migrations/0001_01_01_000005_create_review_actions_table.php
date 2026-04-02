<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('review_actions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('document_id');
            $table->foreign('document_id')
                  ->references('id')
                  ->on('documents')
                  ->cascadeOnDelete();
            $table->uuid('reviewer_id')->nullable();
            $table->foreign('reviewer_id')
                  ->references('id')
                  ->on('users')
                  ->nullOnDelete();
            $table->enum('action', ['claim', 'release', 'accept', 'override', 'reject', 'assign']);
            $table->string('from_category', 64)->nullable();
            $table->string('to_category', 64)->nullable();
            $table->text('comment')->nullable();
            $table->unsignedInteger('duration_seconds')->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index('document_id');
            $table->index('reviewer_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('review_actions');
    }
};

<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('original_name', 512);
            $table->string('stored_filename', 512)->nullable();
            $table->string('applicant_name', 128);
            $table->string('applicant_lastname', 128);
            $table->string('category_predicted', 64);
            $table->float('category_confidence')->default(0.0);
            $table->string('category_final', 64)->nullable();
            $table->enum('status', ['uploaded', 'queued', 'in_review', 'resolved'])->default('uploaded');
            $table->uuid('assigned_reviewer_id')->nullable();
            $table->foreign('assigned_reviewer_id')
                  ->references('id')
                  ->on('users')
                  ->nullOnDelete();
            $table->timestamp('review_started_at')->nullable();
            $table->timestamp('resolved_at')->nullable();
            $table->unsignedInteger('size_bytes')->nullable();
            $table->timestamps();

            $table->index('status');
            $table->index('category_predicted');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
    }
};

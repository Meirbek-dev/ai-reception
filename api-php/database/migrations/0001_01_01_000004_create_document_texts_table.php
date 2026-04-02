<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_texts', function (Blueprint $table) {
            $table->uuid('document_id')->primary();
            $table->foreign('document_id')
                  ->references('id')
                  ->on('documents')
                  ->cascadeOnDelete();
            $table->text('text_excerpt')->nullable();
            $table->timestamp('created_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('document_texts');
    }
};

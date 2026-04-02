<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('documents', function (Blueprint $table) {
            $table->string('applicant_name_normalized', 128)->default('')->after('applicant_name');
            $table->string('applicant_lastname_normalized', 128)->default('')->after('applicant_lastname');
            $table->string('processing_path', 512)->nullable()->after('stored_filename');
            $table->string('processing_state', 32)->nullable()->after('status');
            $table->text('processing_error')->nullable()->after('processing_path');

            $table->index(['status', 'created_at', 'id'], 'documents_status_created_id_index');
            $table->index([
                'applicant_lastname_normalized',
                'applicant_name_normalized',
                'created_at',
            ], 'documents_applicant_lookup_index');
            $table->index('processing_state');
        });

        $documents = DB::table('documents')
            ->select(['id', 'applicant_name', 'applicant_lastname'])
            ->get();

        foreach ($documents as $document) {
            DB::table('documents')
                ->where('id', $document->id)
                ->update([
                    'applicant_name_normalized' => $this->normalizeApplicantLookup((string) $document->applicant_name),
                    'applicant_lastname_normalized' => $this->normalizeApplicantLookup((string) $document->applicant_lastname),
                ]);
        }

        Schema::table('review_actions', function (Blueprint $table) {
            $table->index(['document_id', 'created_at'], 'review_actions_document_created_index');
        });
    }

    public function down(): void
    {
        Schema::table('review_actions', function (Blueprint $table) {
            $table->dropIndex('review_actions_document_created_index');
        });

        Schema::table('documents', function (Blueprint $table) {
            $table->dropIndex('documents_status_created_id_index');
            $table->dropIndex('documents_applicant_lookup_index');
            $table->dropIndex(['processing_state']);
            $table->dropColumn([
                'applicant_name_normalized',
                'applicant_lastname_normalized',
                'processing_path',
                'processing_state',
                'processing_error',
            ]);
        });
    }

    private function normalizeApplicantLookup(string $value): string
    {
        $normalized = mb_strtolower(trim($value));
        $normalized = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $normalized) ?? '';

        return trim($normalized);
    }
};

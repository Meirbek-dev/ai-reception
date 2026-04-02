<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Document extends Model
{
    use HasUuids;

    protected $keyType = 'string';
    public $incrementing = false;

    protected $fillable = [
        'id',
        'original_name',
        'stored_filename',
        'processing_path',
        'processing_error',
        'applicant_name',
        'applicant_name_normalized',
        'applicant_lastname',
        'applicant_lastname_normalized',
        'category_predicted',
        'category_confidence',
        'category_final',
        'status',
        'processing_state',
        'assigned_reviewer_id',
        'review_started_at',
        'resolved_at',
        'size_bytes',
    ];

    protected function casts(): array
    {
        return [
            'category_confidence' => 'float',
            'review_started_at'   => 'datetime',
            'resolved_at'         => 'datetime',
            'size_bytes'          => 'integer',
        ];
    }

    public function effectiveStatus(): string
    {
        return $this->processing_state ?: $this->status;
    }

    public function effectiveCategory(): string
    {
        return $this->category_final ?: $this->category_predicted;
    }

    public function reviewer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_reviewer_id');
    }

    public function text(): HasOne
    {
        return $this->hasOne(DocumentText::class, 'document_id');
    }

    public function actions(): HasMany
    {
        return $this->hasMany(ReviewAction::class, 'document_id');
    }
}

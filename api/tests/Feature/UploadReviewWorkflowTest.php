<?php

use App\Models\Document;
use App\Models\DocumentText;
use App\Models\ReviewAction;
use App\Models\User;
use App\Services\ClassifierService;
use App\Services\DocumentService;
use App\Services\OcrService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

function mockUploadPipeline(string $extractedText, array $classification, string $status): void
{
    $ocr = \Mockery::mock(OcrService::class);
    $ocr->shouldReceive('extractText')
        ->once()
        ->andReturn($extractedText);
    app()->instance(OcrService::class, $ocr);

    $classifier = \Mockery::mock(ClassifierService::class);
    $classifier->shouldReceive('classify')
        ->once()
        ->andReturn($classification);
    $classifier->shouldReceive('determineStatus')
        ->once()
        ->with($classification['confidence'])
        ->andReturn($status);
    app()->instance(ClassifierService::class, $classifier);
}

beforeEach(function () {
    $this->testStoragePath = base_path('tests/tmp/storage-'.uniqid('', true));
    File::ensureDirectoryExists($this->testStoragePath);
    app()->useStoragePath($this->testStoragePath);
    config(['queue.default' => 'database']);
});

afterEach(function () {
    if (isset($this->testStoragePath)) {
        File::deleteDirectory($this->testStoragePath);
    }
});

it('supports uploading a document and completing the review workflow', function () {
    mockUploadPipeline(
        'Сертификат с результатами тестирования абитуриента.',
        [
            'category' => 'ENT',
            'confidence' => 0.74,
            'fuzzy_score' => 82.0,
        ],
        'queued'
    );

    $uploadResponse = $this->post('/upload', [
        'name' => 'Aruzhan',
        'lastname' => 'Saparova',
        'files' => [
            UploadedFile::fake()->create('ent-certificate.pdf', 32, 'application/pdf'),
        ],
    ]);

    $uploadResponse
        ->assertOk()
        ->assertJsonPath('summary.total', 1)
        ->assertJsonPath('summary.accepted', 1)
        ->assertJsonPath('summary.failed', 0)
        ->assertJsonPath('success.0.originalName', 'ent-certificate.pdf')
        ->assertJsonPath('success.0.status', 'processing');

    $document = Document::query()->sole();

    expect($document->original_name)->toBe('ent-certificate.pdf');
    expect($document->processing_state)->toBe('processing');
    expect($document->stored_filename)->toBeNull();

    app(DocumentService::class)->processQueuedDocument($document->id);

    $document = $document->fresh();

    expect($document->status)->toBe('queued');
    expect($document->processing_state)->toBeNull();
    expect($document->category_predicted)->toBe('ENT');
    expect(DocumentText::query()->where('document_id', $document->id)->sole()->text_excerpt)->toContain('тестирования');

    $storedPath = $this->testStoragePath.'/app/'.$document->stored_filename;
    expect($document->stored_filename)->not->toBeNull();
    expect(File::exists($storedPath))->toBeTrue();

    $this->getJson('/files?name=Aruzhan&lastname=Saparova')
        ->assertOk()
        ->assertJsonCount(1)
        ->assertJsonPath('0.id', $document->id)
        ->assertJsonPath('0.originalName', 'ent-certificate.pdf')
        ->assertJsonPath('0.category', 'ENT');

    $reviewer = User::create([
        'email' => 'reviewer@example.com',
        'display_name' => 'Queue Reviewer',
        'role' => 'reviewer',
        'password' => 'secret-password',
        'is_active' => true,
    ]);

    Sanctum::actingAs($reviewer);

    $this->getJson('/admin/review-queue?status=queued')
        ->assertOk()
        ->assertJsonCount(1, 'data')
        ->assertJsonPath('data.0.id', $document->id)
        ->assertJsonPath('data.0.status', 'queued');

    $this->postJson("/admin/review-queue/{$document->id}/claim")
        ->assertOk()
        ->assertJsonPath('id', $document->id)
        ->assertJsonPath('status', 'in_review')
        ->assertJsonPath('assigned_reviewer_id', $reviewer->id);

    $this->postJson("/admin/review-queue/{$document->id}/resolve", [
        'final_category' => 'Diplom',
        'applicant_name' => 'Aruzhan',
        'applicant_lastname' => 'Saparova',
        'comment' => 'Manual review confirmed this belongs in diploma documents.',
    ])
        ->assertOk()
        ->assertJsonPath('id', $document->id)
        ->assertJsonPath('status', 'resolved')
        ->assertJsonPath('category_predicted', 'ENT')
        ->assertJsonPath('category_final', 'Diplom')
        ->assertJsonPath('assigned_reviewer_id', $reviewer->id);

    expect($document->fresh()->status)->toBe('resolved');
    expect($document->fresh()->category_final)->toBe('Diplom');
    expect($document->fresh()->assigned_reviewer_id)->toBe($reviewer->id);
    expect($document->fresh()->resolved_at)->not->toBeNull();

    $this->getJson("/admin/review-queue/{$document->id}/audit")
        ->assertOk()
        ->assertJsonCount(2)
        ->assertJsonPath('0.action', 'claim')
        ->assertJsonPath('1.action', 'override')
        ->assertJsonPath('1.to_category', 'Diplom')
        ->assertJsonPath('1.reviewer_email', 'reviewer@example.com');

    expect(ReviewAction::query()->where('document_id', $document->id)->count())->toBe(2);
});

it('marks high-confidence uploads as uploaded and keeps them out of the review queue', function () {
    mockUploadPipeline(
        'Удостоверение личности абитуриента с полными реквизитами и серийным номером.',
        [
            'category' => 'Udostoverenie',
            'confidence' => 0.98,
            'fuzzy_score' => null,
        ],
        'uploaded'
    );

    $uploadResponse = $this->post('/upload', [
        'name' => 'Dana',
        'lastname' => 'Ibrayeva',
        'files' => [
            UploadedFile::fake()->create('id-card.pdf', 24, 'application/pdf'),
        ],
    ]);

    $uploadResponse
        ->assertOk()
        ->assertJsonPath('summary.total', 1)
        ->assertJsonPath('summary.accepted', 1)
        ->assertJsonPath('summary.failed', 0)
        ->assertJsonPath('summary.unclassified', 0)
        ->assertJsonPath('success.0.originalName', 'id-card.pdf')
        ->assertJsonPath('success.0.status', 'processing');

    $document = Document::query()->sole();

    app(DocumentService::class)->processQueuedDocument($document->id);

    $document = $document->fresh();

    expect($document->original_name)->toBe('id-card.pdf');
    expect($document->status)->toBe('uploaded');
    expect($document->category_predicted)->toBe('Udostoverenie');
    expect($document->category_confidence)->toBe(0.98);
    expect($document->stored_filename)->not->toBeNull();
    expect($document->assigned_reviewer_id)->toBeNull();
    expect($document->category_final)->toBeNull();

    $storedPath = $this->testStoragePath.'/app/'.$document->stored_filename;
    expect(File::exists($storedPath))->toBeTrue();

    $this->getJson('/files?name=Dana&lastname=Ibrayeva')
        ->assertOk()
        ->assertJsonCount(1)
        ->assertJsonPath('0.id', $document->id)
        ->assertJsonPath('0.category', 'Udostoverenie');

    $reviewer = User::create([
        'email' => 'uploaded-reviewer@example.com',
        'display_name' => 'Uploaded Reviewer',
        'role' => 'reviewer',
        'password' => 'secret-password',
        'is_active' => true,
    ]);

    Sanctum::actingAs($reviewer);

    $this->getJson('/admin/review-queue?status=queued')
        ->assertOk()
        ->assertJsonCount(0, 'data');

    $this->getJson('/admin/review-queue?status=uploaded')
        ->assertOk()
        ->assertJsonCount(1, 'data')
        ->assertJsonPath('data.0.id', $document->id)
        ->assertJsonPath('data.0.status', 'uploaded');

    expect(ReviewAction::query()->where('document_id', $document->id)->count())->toBe(0);
});

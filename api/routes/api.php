<?php

use App\Http\Controllers\Admin\ReviewQueueController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\FileController;
use Illuminate\Support\Facades\Route;

// ─── Public endpoints ────────────────────────────────────────────────────────

Route::get('/health', [FileController::class, 'health']);

// ─── Auth ─────────────────────────────────────────────────────────────────────

Route::post('/auth/login', [AuthController::class, 'login']);

Route::middleware('auth:sanctum')->group(function () {
    Route::post('/auth/logout',  [AuthController::class, 'logout']);
    Route::post('/auth/refresh', [AuthController::class, 'refresh']);
    Route::get('/auth/me',       [AuthController::class, 'me']);
});

// ─── File management ─────────────────────────────────────────────────────────

Route::post('/upload',           [FileController::class, 'upload'])
     ->middleware('throttle:upload');

Route::get('/files',             [FileController::class, 'index']);
Route::get('/files/{id}',        [FileController::class, 'show']);
Route::get('/download_zip',      [FileController::class, 'downloadZip']);
Route::delete('/files/{id}',     [FileController::class, 'destroy']);

// ─── Admin / Review queue ────────────────────────────────────────────────────

Route::prefix('admin')
     ->middleware(['auth:sanctum', 'role:reviewer,admin'])
     ->group(function () {
         Route::get('/review-queue',                          [ReviewQueueController::class, 'index']);
         Route::post('/review-queue/{document}/claim',        [ReviewQueueController::class, 'claim']);
         Route::post('/review-queue/{document}/release',      [ReviewQueueController::class, 'release']);
         Route::post('/review-queue/{document}/resolve',      [ReviewQueueController::class, 'resolve']);
         Route::get('/review-queue/{document}',               [ReviewQueueController::class, 'show']);
         Route::get('/review-queue/{document}/audit',         [ReviewQueueController::class, 'audit']);
         Route::get('/review-queue/{document}/preview',       [ReviewQueueController::class, 'preview']);

     });

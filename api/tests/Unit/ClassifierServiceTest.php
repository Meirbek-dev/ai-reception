<?php

use App\Services\ClassifierService;

it('does not classify a document from a single generic keyword', function () {
    $service = new ClassifierService();

    $result = $service->classify('Выдана справка без диагноза и без других признаков документа.');

    expect($result['category'])->toBe('Unclassified');
    expect($result['confidence'])->toBe(0.0);
});

it('matches medical certificates despite latin-cyrillic OCR mixups', function () {
    $service = new ClassifierService();

    $result = $service->classify('Мedицинcкая cправка о прохождении медосмотра и анализе крови.');

    expect($result['category'])->toBe('MedSpravka');
    expect($result['confidence'])->toBeGreaterThan(0.0);
});

it('prefers the strongest category instead of first weak keyword hit', function () {
    $service = new ClassifierService();

    $result = $service->classify('Сертификат с результатами тестирования, набранные баллы и данные абитуриента.');

    expect($result['category'])->toBe('ENT');
    expect($result['confidence'])->toBeGreaterThan(0.0);
});

it('recognizes identity documents from noisy OCR text', function () {
    $service = new ClassifierService();

    $result = $service->classify('Удоcтовeрение личнocти гражданина с серийным номером.');

    expect($result['category'])->toBe('Udostoverenie');
    expect($result['confidence'])->toBeGreaterThan(0.0);
});

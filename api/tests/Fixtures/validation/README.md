# Validation Dataset Scaffold

This directory is intentionally a scaffold only.

Real validation documents are not committed because they can contain sensitive applicant data.

Use this folder to build a representative benchmark set before changing OCR parameters or classifier heuristics.

## Expected workflow

1. Copy the manifest template from `manifest.example.json` to a private manifest file.
2. Place representative documents in a private path that is not committed.
3. Fill the manifest with the relative paths and expected categories.
4. Run `php artisan documents:validate-pipeline path/to/manifest.json`.
5. Record the baseline results before tuning OCR or classifier logic.

## Coverage guidance

- include all supported categories
- include both easy and low-quality scans
- include PDFs and images
- include documents that are visually similar but belong to different categories
- keep a mix of high-confidence and low-confidence cases

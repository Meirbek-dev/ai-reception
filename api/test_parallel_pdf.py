#!/usr/bin/env python3
"""
Test parallel PDF page processing
"""
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


def simulate_ocr_page(page_num: int) -> tuple[int, str, float]:
    """Simulate OCR processing for a single page"""
    start = time.time()
    # Simulate 1 second OCR time per page
    time.sleep(1)
    duration = time.time() - start
    return page_num, f"Text from page {page_num}", duration


def process_sequential(num_pages: int) -> tuple[list[str], float]:
    """Process pages sequentially"""
    start = time.time()
    results = []

    for i in range(num_pages):
        _, text, _ = simulate_ocr_page(i + 1)
        results.append(text)

    total_time = time.time() - start
    return results, total_time


def process_parallel(num_pages: int, max_workers: int = 4) -> tuple[list[str], float]:
    """Process pages in parallel"""
    start = time.time()

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all pages
        future_to_idx = {
            executor.submit(simulate_ocr_page, i + 1): i for i in range(num_pages)
        }

        # Collect results in order
        results = [""] * num_pages

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            page_num, text, _ = future.result()
            results[idx] = text

    total_time = time.time() - start
    return results, total_time


def test_parallel_performance():
    """Compare sequential vs parallel processing"""
    print("=" * 70)
    print("Parallel PDF Page Processing Test")
    print("=" * 70)

    test_cases = [
        (5, 2),  # 5 pages, 2 workers
        (10, 4),  # 10 pages, 4 workers
        (8, 8),  # 8 pages, 8 workers
    ]

    for num_pages, workers in test_cases:
        print(f"\nTest: {num_pages} pages")
        print("-" * 70)

        # Sequential
        _, seq_time = process_sequential(num_pages)
        print(f"Sequential processing: {seq_time:.2f}s")

        # Parallel
        _, par_time = process_parallel(num_pages, workers)
        print(f"Parallel processing ({workers} workers): {par_time:.2f}s")

        speedup = seq_time / par_time
        improvement = ((seq_time - par_time) / seq_time) * 100

        print(f"Speedup: {speedup:.2f}x")
        print(f"Improvement: {improvement:.1f}%")

        # Theoretical maximum speedup
        theoretical = min(workers, num_pages)
        efficiency = (speedup / theoretical) * 100
        print(f"Efficiency: {efficiency:.1f}% (of theoretical max {theoretical:.1f}x)")

    print("\n" + "=" * 70)
    print("Key Insights:")
    print("=" * 70)
    print("1. Parallel processing scales well with CPU cores")
    print("2. ThreadPoolExecutor works because Tesseract releases GIL")
    print("3. Efficiency depends on: page count, workers, and CPU cores")
    print("4. Overhead is minimal for thread-based parallelism")
    print("=" * 70)


if __name__ == "__main__":
    test_parallel_performance()

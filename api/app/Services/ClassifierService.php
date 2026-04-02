<?php

namespace App\Services;

class ClassifierService
{
    // Confidence threshold - documents below this go to review queue
    public const CONFIDENCE_THRESHOLD = 0.95;

    /**
     * Keyword dictionary — mirrors Python's CategoryKeywords dataclass exactly.
     */
    private const CATEGORIES = [
        'Udostoverenie' => ['удостоверение', 'ID'],
        'ENT'           => ['сертификат', 'ТЕСТИРОВАНИЯ', 'ТЕСТІЛЕУ', 'ТЕСТИРУЕМОГО', 'Набранные баллы'],
        'Lgota'         => ['льгота', 'инвалид', 'многодетная'],
        'Diplom'        => ['диплом', 'аттестат', 'бакалавр', 'магистр'],
        'Privivka'      => ['прививка', 'прививочный паспорт', 'вакцинирование', 'инфекция'],
        'MedSpravka'    => [
            'медицинская справка', 'справка', 'медицинский',
            'туберкулез', 'полиомелит', 'гепатит', 'вич', 'спид',
            'карта ребенка', 'Дегельминтизация', 'дегельминтизация',
            'клинический анализ крови', 'анализ крови', 'анализ мочи',
            'моча', 'кровь', 'флюорография', 'флюорографическое обследование',
            'флюорография легких',
        ],
    ];

    /**
     * Classify text, returning ['category' => string, 'confidence' => float, 'fuzzy_score' => float|null].
     *
     * Mirrors classify_text() + compute_confidence_score() from Python.
     */
    public function classify(string $text): array
    {
        if (trim($text) === '') {
            return ['category' => 'Unclassified', 'confidence' => 0.0, 'fuzzy_score' => 0.0];
        }

        $lower = mb_strtolower($text);

        // --- Fast exact containment check ---
        foreach (self::CATEGORIES as $category => $keywords) {
            foreach ($keywords as $keyword) {
                if ($keyword !== '' && mb_strpos($lower, mb_strtolower($keyword)) !== false) {
                    $confidence = $this->computeConfidence($category, $text, null);
                    return ['category' => $category, 'confidence' => $confidence, 'fuzzy_score' => null];
                }
            }
        }

        // --- Fuzzy fallback using token-set ratio ---
        $bestCategory = 'Unclassified';
        $bestScore    = 0.0;

        foreach (self::CATEGORIES as $category => $keywords) {
            foreach ($keywords as $keyword) {
                if ($keyword === '') {
                    continue;
                }
                $score = $this->tokenSetRatio(mb_strtolower($keyword), $lower);
                if ($score > $bestScore) {
                    $bestScore    = $score;
                    $bestCategory = $category;
                }
            }
        }

        if ($bestScore >= 60.0) {
            $confidence = $this->computeConfidence($bestCategory, $text, $bestScore);
            return ['category' => $bestCategory, 'confidence' => $confidence, 'fuzzy_score' => $bestScore];
        }

        return ['category' => 'Unclassified', 'confidence' => 0.0, 'fuzzy_score' => 0.0];
    }

    /**
     * Compute confidence score — mirrors compute_confidence_score() exactly.
     *
     * @param  string     $category
     * @param  string     $text
     * @param  float|null $fuzzyScore  null for exact matches, 0-100 for fuzzy
     */
    public function computeConfidence(string $category, string $text, ?float $fuzzyScore): float
    {
        if (in_array($category, ['Unclassified', 'ERROR'], true)) {
            return 0.0;
        }

        // Base confidence
        if ($fuzzyScore === null) {
            $confidence = 0.95;
        } else {
            $confidence = 0.6 + ($fuzzyScore / 100.0) * 0.3;
        }

        // Adjust for text length
        $textLen = mb_strlen(trim($text));
        if ($textLen < 50) {
            $confidence *= 0.5;
        } elseif ($textLen < 150) {
            $confidence *= 0.75;
        } elseif ($textLen < 300) {
            $confidence *= 0.9;
        }

        return round($confidence, 3);
    }

    /**
     * Determine initial review status based on confidence.
     * Mirrors determine_review_status() from Python.
     */
    public function determineStatus(float $confidence): string
    {
        return $confidence >= self::CONFIDENCE_THRESHOLD ? 'uploaded' : 'queued';
    }

    /**
     * PHP port of rapidfuzz token_set_ratio.
     *
     * Splits both strings into word bags, computes:
     *   sorted intersection, (intersection + rest1), (intersection + rest2)
     * and returns the max similarity * 100.
     */
    private function tokenSetRatio(string $a, string $b): float
    {
        $tokensA = array_unique(preg_split('/\s+/', trim($a)));
        $tokensB = array_unique(preg_split('/\s+/', trim($b)));
        sort($tokensA);
        sort($tokensB);

        $intersection = array_intersect($tokensA, $tokensB);
        sort($intersection);

        $diffA = array_diff($tokensA, $intersection);
        $diffB = array_diff($tokensB, $intersection);

        $intersStr = implode(' ', $intersection);
        $str1      = trim($intersStr.' '.implode(' ', $diffA));
        $str2      = trim($intersStr.' '.implode(' ', $diffB));

        $scores = [
            $this->strSimilarity($intersStr, $str1),
            $this->strSimilarity($intersStr, $str2),
            $this->strSimilarity($str1, $str2),
        ];

        return max($scores) * 100;
    }

    /**
     * Returns similarity ratio between 0 and 1 using similar_text().
     */
    private function strSimilarity(string $a, string $b): float
    {
        if ($a === '' && $b === '') {
            return 1.0;
        }
        if ($a === '' || $b === '') {
            return 0.0;
        }
        similar_text($a, $b, $percent);
        return $percent / 100.0;
    }
}

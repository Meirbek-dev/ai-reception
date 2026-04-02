<?php

namespace App\Services;

class ClassifierService
{
    // Confidence threshold - documents below this go to review queue
    public const CONFIDENCE_THRESHOLD = 0.95;
    private const MIN_CLASSIFICATION_SCORE = 62.0;
    private const MIN_DECISIVE_MARGIN = 8.0;

    /**
     * Keyword dictionary — mirrors Python's CategoryKeywords dataclass exactly.
     */
    private const CATEGORIES = [
        'Udostoverenie' => ['удостоверение личности', 'удостоверение', 'личности', 'ID'],
        'ENT'           => ['сертификат', 'ТЕСТИРОВАНИЯ', 'ТЕСТІЛЕУ', 'ТЕСТИРУЕМОГО', 'Набранные баллы', 'результаты тестирования'],
        'Lgota'         => ['льгота', 'инвалид', 'инвалидность', 'многодетная', 'многодетная семья'],
        'Diplom'        => ['диплом', 'аттестат', 'аттестат о среднем образовании', 'бакалавр', 'магистр'],
        'Privivka'      => ['прививка', 'прививочный паспорт', 'карта профилактических прививок', 'вакцинирование', 'вакцинация', 'инфекция'],
        'MedSpravka'    => [
            'медицинская справка', 'справка', 'медицинский',
            'туберкулез', 'полиомелит', 'гепатит', 'вич', 'спид',
            'карта ребенка', 'Дегельминтизация', 'дегельминтизация',
            'клинический анализ крови', 'анализ крови', 'анализ мочи',
            'моча', 'кровь', 'флюорография', 'флюорографическое обследование',
            'флюорография легких',
        ],
    ];

    private const GENERIC_KEYWORD_WEIGHTS = [
        'id' => 0.45,
        'личности' => 0.45,
        'справка' => 0.25,
        'медицинский' => 0.35,
        'инфекция' => 0.35,
        'кровь' => 0.35,
        'моча' => 0.35,
        'инвалид' => 0.45,
        'льгота' => 0.5,
        'диплом' => 0.6,
        'аттестат' => 0.62,
    ];

    private const OCR_CONFUSABLES = [
        'a' => 'а',
        'b' => 'в',
        'c' => 'с',
        'e' => 'е',
        'h' => 'н',
        'k' => 'к',
        'm' => 'м',
        'o' => 'о',
        'p' => 'р',
        't' => 'т',
        'x' => 'х',
        'y' => 'у',
    ];

    private ?array $normalizedCategories = null;

    /**
     * Classify text, returning ['category' => string, 'confidence' => float, 'fuzzy_score' => float|null].
     *
     * Mirrors classify_text() + compute_confidence_score() from Python.
     */
    public function classify(string $text): array
    {
        $profile = $this->buildTextProfile($text);

        if ($profile['normalized_text'] === '') {
            return ['category' => 'Unclassified', 'confidence' => 0.0, 'fuzzy_score' => 0.0];
        }

        $ranked = [];
        foreach ($this->normalizedCategories() as $category => $keywords) {
            $ranked[$category] = $this->scoreCategory($keywords, $profile);
        }

        uasort($ranked, fn (array $left, array $right) => $right['score'] <=> $left['score']);

        $bestCategory = array_key_first($ranked) ?: 'Unclassified';
        $best = $ranked[$bestCategory] ?? ['score' => 0.0, 'exact_hits' => 0, 'strong_hits' => 0];
        $runnerUp = array_values($ranked)[1] ?? ['score' => 0.0];
        $bestScore = (float) $best['score'];
        $runnerUpScore = (float) ($runnerUp['score'] ?? 0.0);

        if (! $this->isDecisiveMatch($bestScore, $runnerUpScore, (int) $best['strong_hits'])) {
            return ['category' => 'Unclassified', 'confidence' => 0.0, 'fuzzy_score' => round($bestScore, 1)];
        }

        $exactWinner = (int) $best['exact_hits'] > 0
            && $bestScore >= 95.0
            && ($bestScore - $runnerUpScore) >= 15.0;

        $confidence = $this->computeConfidence(
            $bestCategory,
            $profile['normalized_text'],
            $exactWinner ? null : $bestScore
        );

        return [
            'category' => $bestCategory,
            'confidence' => $confidence,
            'fuzzy_score' => $exactWinner ? null : round($bestScore, 1),
        ];
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
        $threshold = (float) config('app.confidence_threshold', self::CONFIDENCE_THRESHOLD);

        return $confidence >= $threshold ? 'uploaded' : 'queued';
    }

    /**
     * PHP port of rapidfuzz token_set_ratio.
     *
     * Splits both strings into word bags, computes:
     *   sorted intersection, (intersection + rest1), (intersection + rest2)
     * and returns the max similarity * 100.
     */
    private function tokenSetRatioFromTokens(array $tokensA, array $tokensB): float
    {
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

    private function normalizedCategories(): array
    {
        if ($this->normalizedCategories !== null) {
            return $this->normalizedCategories;
        }

        $this->normalizedCategories = [];

        foreach (self::CATEGORIES as $category => $keywords) {
            $this->normalizedCategories[$category] = array_map(function (string $keyword) {
                $normalized = $this->normalizeForMatching($keyword);
                $sequenceTokens = $this->tokenizeSequence($normalized);
                $tokens = $this->tokenize($normalized);

                return [
                    'value' => $normalized,
                    'compact' => str_replace(' ', '', $normalized),
                    'tokens' => $tokens,
                    'sequence_tokens' => $sequenceTokens,
                    'weight' => $this->keywordWeight($normalized, $tokens),
                ];
            }, $keywords);
        }

        return $this->normalizedCategories;
    }

    private function tokenize(string $value): array
    {
        $tokens = $this->tokenizeSequence($value);
        $tokens = array_values(array_unique(array_filter($tokens, fn (string $token) => $token !== '')));
        sort($tokens);

        return $tokens;
    }

    private function tokenizeSequence(string $value): array
    {
        return array_values(array_filter(
            preg_split('/\s+/u', trim($value)) ?: [],
            fn (string $token) => $token !== ''
        ));
    }

    private function buildTextProfile(string $text): array
    {
        $normalizedText = $this->normalizeForMatching($text);

        return [
            'normalized_text' => $normalizedText,
            'compact_text' => str_replace(' ', '', $normalizedText),
            'tokens' => $this->tokenize($normalizedText),
            'sequence_tokens' => $this->tokenizeSequence($normalizedText),
        ];
    }

    private function normalizeForMatching(string $value): string
    {
        $normalized = mb_strtolower(trim($value));
        $normalized = str_replace('ё', 'е', $normalized);
        $normalized = strtr($normalized, self::OCR_CONFUSABLES);
        $normalized = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $normalized) ?? '';

        return trim(preg_replace('/\s+/u', ' ', $normalized) ?? '');
    }

    private function keywordWeight(string $keyword, array $tokens): float
    {
        $compact = str_replace(' ', '', $keyword);
        $weight = 0.45 + (min(count($tokens), 3) * 0.12) + (min(mb_strlen($compact), 24) * 0.01);

        if (isset(self::GENERIC_KEYWORD_WEIGHTS[$keyword])) {
            $weight = min($weight, self::GENERIC_KEYWORD_WEIGHTS[$keyword]);
        }

        return max(0.2, min(1.0, $weight));
    }

    private function scoreCategory(array $keywords, array $profile): array
    {
        $weightedScores = [];
        $exactHits = 0;
        $strongHits = 0;

        foreach ($keywords as $keyword) {
            $matchScore = $this->scoreKeywordMatch($keyword, $profile);
            $weighted = min(100.0, $matchScore * (float) $keyword['weight']);

            if ($matchScore >= 99.9) {
                $exactHits++;
            }

            if ($weighted >= 55.0) {
                $strongHits++;
            }

            $weightedScores[] = $weighted;
        }

        rsort($weightedScores);

        $top = $weightedScores[0] ?? 0.0;
        $second = $weightedScores[1] ?? 0.0;
        $third = $weightedScores[2] ?? 0.0;
        $score = min(100.0, $top + ($second * 0.45) + ($third * 0.2) + min(max($strongHits - 1, 0) * 8.0, 16.0));

        return [
            'score' => round($score, 2),
            'exact_hits' => $exactHits,
            'strong_hits' => $strongHits,
        ];
    }

    private function scoreKeywordMatch(array $keyword, array $profile): float
    {
        if ($keyword['value'] === '') {
            return 0.0;
        }

        if (mb_strpos($profile['normalized_text'], $keyword['value']) !== false) {
            return 100.0;
        }

        if ($keyword['compact'] !== '' && str_contains($profile['compact_text'], $keyword['compact'])) {
            return 100.0;
        }

        $coverageScore = $this->tokenCoverageScore($keyword['tokens'], $profile['tokens']);
        $setRatio = $this->tokenSetRatioFromTokens($keyword['tokens'], $profile['tokens']);
        $windowScore = $this->bestTokenWindowScore($keyword['sequence_tokens'], $profile['sequence_tokens']);

        if ($coverageScore < 75.0) {
            $windowScore = 0.0;
        }

        return max($coverageScore, $setRatio, $windowScore);
    }

    private function tokenCoverageScore(array $keywordTokens, array $textTokens): float
    {
        if ($keywordTokens === [] || $textTokens === []) {
            return 0.0;
        }

        $scores = [];
        foreach ($keywordTokens as $keywordToken) {
            $best = 0.0;
            foreach ($textTokens as $textToken) {
                $best = max($best, $this->strSimilarity($keywordToken, $textToken));
                if ($best >= 0.999) {
                    break;
                }
            }
            $scores[] = $best;
        }

        $average = array_sum($scores) / count($scores);
        $minimum = min($scores);
        $exactFraction = count(array_filter($scores, fn (float $score) => $score >= 0.999)) / count($scores);

        return $average * max($minimum, $exactFraction) * 100;
    }

    private function bestTokenWindowScore(array $keywordTokens, array $textTokens): float
    {
        $keywordCount = count($keywordTokens);
        $textCount = count($textTokens);

        if ($keywordCount === 0 || $textCount === 0) {
            return 0.0;
        }

        $needle = implode(' ', $keywordTokens);
        $windowSizes = array_values(array_unique([$keywordCount, $keywordCount + 1]));
        $best = 0.0;

        foreach ($windowSizes as $windowSize) {
            if ($windowSize > $textCount) {
                continue;
            }

            for ($offset = 0; $offset <= ($textCount - $windowSize); $offset++) {
                $window = array_slice($textTokens, $offset, $windowSize);
                $best = max($best, $this->strSimilarity($needle, implode(' ', $window)) * 100);
            }
        }

        return $best;
    }

    private function isDecisiveMatch(float $bestScore, float $runnerUpScore, int $strongHits): bool
    {
        if ($bestScore < self::MIN_CLASSIFICATION_SCORE) {
            return false;
        }

        if ($bestScore >= 80.0) {
            return true;
        }

        return ($bestScore - $runnerUpScore) >= self::MIN_DECISIVE_MARGIN || $strongHits >= 2;
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

        $left = $this->asciiComparable($a);
        $right = $this->asciiComparable($b);

        if ($left === '' && $right === '') {
            return 1.0;
        }

        $maxLength = max(strlen($left), strlen($right));
        if ($maxLength === 0) {
            return 1.0;
        }

        $distance = levenshtein($left, $right);

        return max(0.0, 1.0 - (min($distance, $maxLength) / $maxLength));
    }

    private function asciiComparable(string $value): string
    {
        if (function_exists('transliterator_transliterate')) {
            $converted = transliterator_transliterate('Any-Latin; Latin-ASCII;', $value);
        } else {
            $converted = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
        }

        $converted = strtolower($converted !== false ? $converted : $value);
        $converted = preg_replace('/[^a-z0-9]+/', ' ', $converted) ?? '';

        return trim($converted);
    }
}

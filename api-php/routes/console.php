<?php

use Illuminate\Support\Facades\Schedule;

// Run the file + cache cleanup every hour.
// Mirrors the cleanup_loop() background task from FastAPI's lifespan.
Schedule::command('app:cleanup-old-files')->hourly();

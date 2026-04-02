<?php

return [

    'default' => env('DB_CONNECTION', 'sqlite'),

    'connections' => [

        'sqlite' => [
            'driver'                  => 'sqlite',
            'url'                     => env('DB_URL'),
            'database'                => env('DB_DATABASE', database_path('database.sqlite')),
            'prefix'                  => '',
            'foreign_key_constraints' => env('DB_FOREIGN_KEYS', true),
            'busy_timeout'            => (int) env('DB_SQLITE_BUSY_TIMEOUT', 5000),
            'journal_mode'            => env('DB_SQLITE_JOURNAL_MODE', 'WAL'),
            'synchronous'             => null,
            'transaction_mode'        => 'DEFERRED',
        ],

    ],

    'migrations' => [
        'table'                => 'migrations',
        'update_date_on_publish' => true,
    ],

];

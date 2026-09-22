<?php
// Meta からの「データ削除リクエスト」の受け口。Meta の仕様どおり確認用のURLとコードを返す。
header("Content-Type: application/json; charset=utf-8");
$code = substr(hash("sha256", (string) microtime(true)), 0, 12);
echo json_encode(["url" => "https://bizcrea.com/threads/deleted.html?code=" . $code, "confirmation_code" => $code]);

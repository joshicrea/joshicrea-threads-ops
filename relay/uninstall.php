<?php
// Meta からの「連携解除」通知の受け口。1人用ツールのため受け取って 200 を返すだけ。
header("Content-Type: application/json; charset=utf-8");
echo json_encode(["ok" => true]);

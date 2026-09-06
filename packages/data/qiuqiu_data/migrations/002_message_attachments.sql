-- 消息带的图。存 blob_id 数组的 JSON，例如 ["image/ab12…"]。
--
-- 原来这一列不存在：发出去的图只在内存里活到刷新为止，重开窗口那条消息就只剩
-- 「带了 1 张图」几个字，图没了。`_JSON_COLUMNS` 会把它解回 list。
ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';

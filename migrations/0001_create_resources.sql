CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  status INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  json TEXT,
  create_time TEXT DEFAULT CURRENT_TIMESTAMP,
  update_time TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resources_type_sort ON resources (type, sort_order, update_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_resources_resource_id ON resources (resource_id);

-- 002: seed users and service accounts (spec §2.1 / §2.3).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO users (username, password_hash, role) VALUES
  ('admin',  crypt('admin',  gen_salt('bf', 8)), 'admin'),
  ('viewer', crypt('viewer', gen_salt('bf', 8)), 'viewer');

INSERT INTO accounts (id) VALUES
  ('acc_01'), ('acc_02'), ('acc_03'), ('acc_04'), ('acc_05'), ('acc_06');

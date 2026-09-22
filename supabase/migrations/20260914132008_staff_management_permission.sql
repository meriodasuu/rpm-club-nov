ALTER TABLE admin_memberships ADD COLUMN can_manage_staff boolean NOT NULL DEFAULT false;
ALTER TABLE admin_memberships ADD CONSTRAINT staff_manager_is_admin CHECK (NOT can_manage_staff OR role='admin');

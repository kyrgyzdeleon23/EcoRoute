import time
import unittest
import uuid
from datetime import date

import app as app_module


class DashboardFeatureTests(unittest.TestCase):
    def setUp(self):
        self.original_is_configured = app_module.is_configured
        app_module.is_configured = lambda: False
        self.client = app_module.app.test_client()
        self.user_id = f"dashboard-test-{uuid.uuid4()}"
        self.audit_log_size = len(app_module.AUDIT_LOG)
        with self.client.session_transaction() as session:
            session.update(
                user_id=self.user_id,
                name="Test Resident",
                role="user",
                last_activity=int(time.time()),
            )
        self.request_ids = []

    def tearDown(self):
        for request_id in self.request_ids:
            app_module.REQUESTS.pop(request_id, None)
            app_module.pq.remove_request(request_id)
        del app_module.AUDIT_LOG[self.audit_log_size:]
        app_module.PROFILE_PHONES.pop(self.user_id, None)
        app_module.is_configured = self.original_is_configured

    def test_admin_request_filters_apply_together(self):
        today = date.today().isoformat()
        matching_id = str(uuid.uuid4())
        other_id = str(uuid.uuid4())
        self.request_ids.extend((matching_id, other_id))
        app_module.REQUESTS[matching_id] = {
            "id": matching_id,
            "user": self.user_id,
            "name": "Test Resident",
            "category": "Displays & CRT Glass",
            "item": "CRT monitor",
            "method": "dropoff",
            "hazard": 4,
            "priority_score": 12,
            "status": "Completed",
            "created_at": f"{today}T09:00:00",
        }
        app_module.REQUESTS[other_id] = {
            "id": other_id,
            "user": self.user_id,
            "name": "Test Resident",
            "category": "Small Peripherals & Electronics",
            "item": "Keyboard",
            "method": "pickup",
            "hazard": 2,
            "priority_score": 6,
            "status": "Pending",
            "created_at": f"{today}T10:00:00",
        }
        with self.client.session_transaction() as session:
            session["role"] = "admin"

        response = self.client.get(
            "/api/admin/requests",
            query_string={
                "status": "Completed",
                "method": "dropoff",
                "hazard": "4",
                "from_date": today,
                "to_date": today,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.get_json()], [matching_id])

    def test_inactive_session_expires_and_config_returns_no_user(self):
        with self.client.session_transaction() as session:
            session["last_activity"] = int(time.time()) - app_module.SESSION_IDLE_TIMEOUT_SECONDS - 1

        response = self.client.get("/api/my-requests")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json(), {"error": "Login required"})
        self.assertIsNone(self.client.get("/api/config").get_json()["user"])

    def test_session_activity_refresh_updates_last_activity(self):
        with self.client.session_transaction() as session:
            session["last_activity"] = int(time.time()) - 120

        response = self.client.post("/api/session/refresh")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "success"})
        with self.client.session_transaction() as session:
            self.assertGreaterEqual(session["last_activity"], int(time.time()) - 1)

    def test_admin_request_filters_reject_invalid_date_range(self):
        with self.client.session_transaction() as session:
            session["role"] = "admin"

        response = self.client.get(
            "/api/admin/requests",
            query_string={"from_date": "2026-11-19", "to_date": "2026-11-18"},
        )

        self.assertEqual(response.status_code, 400)

    def test_request_can_save_default_contact_number(self):
        response = self.client.post(
            "/api/e-waste",
            json={
                "category": "Batteries & Energy Storage",
                "item": "Lithium-ion laptop/phone batteries",
                "method": "pickup",
                "phone": "+63 912-345-6789",
                "save_phone_default": True,
                "latitude": 14.25,
                "longitude": 121.15,
            },
        )
        self.assertEqual(response.status_code, 200)
        request_id = response.get_json()["id"]
        self.request_ids.append(request_id)
        self.assertTrue(app_module.REQUESTS[request_id]["created_at"].endswith("+00:00"))
        self.assertEqual(app_module.PROFILE_PHONES[self.user_id], "+63 912-345-6789")
        config = self.client.get("/api/config").get_json()
        self.assertEqual(config["user"]["phone"], "+63 912-345-6789")

    def test_request_rejects_invalid_contact_number(self):
        response = self.client.post(
            "/api/e-waste",
            json={
                "category": "Batteries & Energy Storage",
                "item": "Lithium-ion laptop/phone batteries",
                "method": "pickup",
                "phone": "call me",
                "latitude": 14.25,
                "longitude": 121.15,
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_audit_history_uses_request_number_after_request_deletion(self):
        request_id = str(uuid.uuid4())
        request_number = "PU-0042"
        self.request_ids.append(request_id)
        app_module.REQUESTS[request_id] = {
            "id": request_id,
            "user": self.user_id,
            "name": "Test Resident",
            "category": "Small Peripherals & Electronics",
            "item": "Keyboard",
            "method": "pickup",
            "request_number": request_number,
            "status": "Pending",
        }
        with self.client.session_transaction() as session:
            session["role"] = "admin"

        response = self.client.delete(f"/api/admin/requests/{request_id}")
        self.assertEqual(response.status_code, 200)
        audit_response = self.client.get("/api/admin/audit")

        self.assertEqual(audit_response.status_code, 200)
        self.assertEqual(audit_response.get_json()[0]["request_number"], request_number)

    def test_admin_rejection_requires_and_saves_a_reason(self):
        request_id = str(uuid.uuid4())
        self.request_ids.append(request_id)
        app_module.REQUESTS[request_id] = {
            "id": request_id,
            "user": self.user_id,
            "name": "Test Resident",
            "category": "Small Peripherals & Electronics",
            "item": "Keyboard",
            "method": "pickup",
            "request_number": "PU-0043",
            "status": "Pending",
            "created_at": "2026-11-20T10:00:00",
        }
        with self.client.session_transaction() as session:
            session["role"] = "admin"

        missing_reason = self.client.post(
            f"/api/admin/requests/{request_id}",
            json={"action": "reject"},
        )
        self.assertEqual(missing_reason.status_code, 400)

        rejected = self.client.post(
            f"/api/admin/requests/{request_id}",
            json={"action": "reject", "reason": "The pickup location is outside our service area."},
        )
        self.assertEqual(rejected.status_code, 200)
        self.assertEqual(
            rejected.get_json()["request"]["rejection_reason"],
            "The pickup location is outside our service area.",
        )

    def test_admin_can_permanently_delete_audit_history_entry(self):
        audit_id = str(uuid.uuid4())
        entry = {
            "audit_id": audit_id,
            "request_id": "deleted-request",
            "request_number": "PU-0044",
            "action": "deleted",
            "admin": "Test Admin",
            "timestamp": "2026-11-20T10:00:00",
        }
        app_module.AUDIT_LOG.append(entry)
        forbidden = self.client.delete(f"/api/admin/audit/{audit_id}")
        self.assertEqual(forbidden.status_code, 403)
        with self.client.session_transaction() as session:
            session.update(name="Test Admin", role="admin")

        deleted = self.client.delete(f"/api/admin/audit/{audit_id}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["audit_id"], audit_id)
        self.assertNotIn(entry, app_module.AUDIT_LOG)
        self.assertEqual(self.client.get("/api/admin/audit").get_json(), [])


if __name__ == "__main__":
    unittest.main()

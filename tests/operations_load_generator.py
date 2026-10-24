"""Completed requests must not consume the bounded load generator's slots."""
import concurrent.futures
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('load_driver',Path(__file__).resolve().parents[1]/'scripts/measure-operations-load.py')
driver=importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
class QueueAccounting(unittest.TestCase):
    def test_completed_slots_are_reclaimed_before_capacity_rejection(self):
        futures={concurrent.futures.Future() for _ in range(driver.MAX_IN_FLIGHT)}
        completed=list(futures)[:20]
        for item in completed:item.set_result('ok')
        seen=[]
        driver.reap_completed(futures,lambda done:seen.extend(f.result() for f in done))
        self.assertEqual(len(futures),driver.MAX_IN_FLIGHT-20)
        self.assertEqual(len(seen),20)
    def test_active_requests_keep_the_capacity_bound(self):
        futures={concurrent.futures.Future() for _ in range(driver.MAX_IN_FLIGHT)}
        driver.reap_completed(futures,lambda done:self.assertFalse(done))
        self.assertEqual(len(futures),driver.MAX_IN_FLIGHT)
if __name__=='__main__':unittest.main()

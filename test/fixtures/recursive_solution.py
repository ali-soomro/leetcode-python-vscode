class Solution:
    def countdown(self, value: int) -> int:
        if value == 0:
            return 0
        return 1 + self.countdown(value - 1)

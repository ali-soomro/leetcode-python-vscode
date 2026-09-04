import os


class Solution:
    def flood(self) -> int:
        os.write(1, b"x" * 262144)
        return 1

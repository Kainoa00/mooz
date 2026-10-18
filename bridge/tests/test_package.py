import pytest

import mooz_agent


@pytest.mark.unit
def test_package_has_docstring() -> None:
    assert mooz_agent.__doc__

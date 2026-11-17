"""Compare the two opening frames in each controlled Playwright fixture run."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


# The fixture's pale fill is close to its background. Keep the high-contrast
# border and text even when they occupy a small part of the menu region.
MIN_CHANGED_FRACTION = 0.02
MIN_CHANNEL_DELTA = 16
MAX_NORMALIZED_ERROR = 0.12
OPENING_FRAMES = ('first', 'second')


class EvidenceUnavailable(ValueError):
    """A comparison cannot be made with the captured evidence."""


def read_region(root, capture, key):
    filename = capture['frames'].get(key)
    if not filename or not (root / filename).is_file():
        raise EvidenceUnavailable(f'Missing {key} frame.')
    image = cv2.imdecode(np.frombuffer((root / filename).read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise EvidenceUnavailable(f'Undecodable {key} frame.')
    width, height = capture['viewport']
    if image.shape[:2] != (height, width):
        raise EvidenceUnavailable(f'{key.capitalize()} frame does not match the captured viewport.')
    x, y, w, h = capture['region']
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
        raise EvidenceUnavailable('The menu region is outside the captured viewport.')
    return image[y:y + h, x:x + w]


def pixel_delta(left, right):
    return cv2.absdiff(left, right).max(axis=2)


def compare_group(root, group):
    reference = group['reference']
    try:
        closed = read_region(root, reference, 'closed')
        opened = read_region(root, reference, 'first')
        contrast = pixel_delta(closed, opened)
        mask = cv2.compare(contrast, MIN_CHANNEL_DELTA, cv2.CMP_GE)
        if cv2.countNonZero(mask) / mask.size < MIN_CHANGED_FRACTION:
            raise EvidenceUnavailable('The reference menu does not change enough pixels to compare.')
        scale = cv2.mean(contrast, mask=mask)[0]
        repeat = read_region(root, reference, 'second')
        if cv2.mean(pixel_delta(opened, repeat), mask=mask)[0] / scale > MAX_NORMALIZED_ERROR:
            raise EvidenceUnavailable('The two reference openings look different.')
    except (EvidenceUnavailable, cv2.error) as error:
        return [unavailable(capture, error) for capture in group['cases']]

    def score(expected, actual):
        return cv2.mean(pixel_delta(expected, actual), mask=mask)[0] / scale

    results = []
    for capture in group['cases']:
        try:
            if capture['region'] != reference['region'] or capture['viewport'] != reference['viewport']:
                raise EvidenceUnavailable('The menu region or viewport differs from the reference.')
            start = score(closed, read_region(root, capture, 'closed'))
            if start > MAX_NORMALIZED_ERROR:
                raise EvidenceUnavailable('The closed frame differs from the reference.')
            errors = [score(opened, read_region(root, capture, key)) for key in OPENING_FRAMES]
            matches = [error <= MAX_NORMALIZED_ERROR for error in errors]
            if matches[0] != matches[1]:
                raise EvidenceUnavailable('The two opening frames disagree.')
            results.append({'variant': capture['variant'], 'outcome': 'pass' if all(matches) else 'fail',
                            'normalizedErrors': [round(error, 4) for error in errors]})
        except (EvidenceUnavailable, cv2.error) as error:
            results.append(unavailable(capture, error))
    return results


def unavailable(capture, error):
    return {'variant': capture['variant'], 'outcome': 'inconclusive', 'reason': str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    groups = json.loads(args.manifest.read_text(encoding='utf-8'))
    print(json.dumps({
        'opencv': cv2.__version__,
        'numpy': np.__version__,
        'maxNormalizedError': MAX_NORMALIZED_ERROR,
        'groups': [compare_group(args.manifest.parent, group) for group in groups],
    }))


if __name__ == '__main__':
    main()

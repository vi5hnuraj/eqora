// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EqoraAssetGate
 * @notice Circuit breaker per instrument: if the oracle price of an asset
 *         jumps more than `jumpThresholdBps` within a one-hour lookback,
 *         borrowing against that asset pauses automatically until an admin
 *         clears it after healthy checks. Indian markets halt trading at
 *         10/20/30% bands; this is the practice-terminal equivalent.
 */
contract EqoraAssetGate is Ownable {
    struct Ref {
        int256 price;
        uint64 at;
        uint64 pausedUntil;
    }

    mapping(string => Ref) private _refs;

    uint256 public jumpThresholdBps = 1000; // 10%
    uint256 public lookback = 1 hours;
    uint256 public pauseDuration = 30 minutes;
    address public reporter;
    address public oracle; // price oracle contract forwards pushes to us

    event PriceRecorded(string symbol, int256 price, uint64 at);
    event AssetPaused(string symbol, uint64 pausedUntil, int256 fromPrice, int256 toPrice);
    event PauseCleared(string symbol);
    event ReporterSet(address indexed reporter);
    event OracleSet(address indexed oracle);

    constructor() {
        reporter = msg.sender;
    }

    function setReporter(address reporter_) external onlyOwner {
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function setJumpThreshold(uint256 bps) external onlyOwner {
        require(bps > 0 && bps <= 5000, "bad threshold");
        jumpThresholdBps = bps;
    }

    function setPauseDuration(uint256 seconds_) external onlyOwner {
        require(seconds_ >= 60 && seconds_ <= 1 days, "bad duration");
        pauseDuration = seconds_;
    }

    /// @dev Called by the price oracle after every price push.
    function recordPrice(string calldata symbol, int256 price) external {
        require(msg.sender == reporter || msg.sender == owner() || msg.sender == oracle, "not reporter");
        Ref storage ref = _refs[symbol];
        if (ref.at != 0 && ref.price > 0 && block.timestamp <= uint256(ref.at) + lookback) {
            uint256 delta = price >= ref.price ? uint256(price - ref.price) : uint256(ref.price - price);
            if (delta * 10000 >= uint256(ref.price) * jumpThresholdBps) {
                ref.pausedUntil = uint64(block.timestamp + pauseDuration);
                emit AssetPaused(symbol, ref.pausedUntil, ref.price, price);
            }
        }
        ref.price = price;
        ref.at = uint64(block.timestamp);
        emit PriceRecorded(symbol, price, uint64(block.timestamp));
    }

    function isPaused(string calldata symbol) external view returns (bool) {
        return _refs[symbol].pausedUntil > block.timestamp;
    }

    function pausedUntil(string calldata symbol) external view returns (uint64) {
        return _refs[symbol].pausedUntil;
    }

    /// @notice Admin review passed — reopen the asset for borrowing.
    function clearPause(string calldata symbol) external onlyOwner {
        _refs[symbol].pausedUntil = 0;
        emit PauseCleared(symbol);
    }
}

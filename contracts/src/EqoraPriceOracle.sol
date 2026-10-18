// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IAssetGateRecorder {
    function recordPrice(string calldata symbol, int256 price) external;
}

/**
 * @title EqoraPriceOracle
 * @notice Push-based price feed for synthetic Indian instruments.
 *         The off-chain reporter (backend/src/reporter) pushes delayed
 *         public market prices here; the pool refuses to use stale data.
 *         Prices use 8 decimals (Chainlink style), denominated in INR.
 */
contract EqoraPriceOracle is Ownable {
    struct PriceData {
        int256 price;
        uint64 updatedAt;
    }

    mapping(string => PriceData) private _prices;

    address public reporter;
    uint64 public maxStaleAge = 1 hours;
    address public gate;

    event PriceUpdated(string symbol, int256 price, uint64 updatedAt);
    event ReporterSet(address indexed reporter);
    event GateSet(address indexed gate);

    constructor() {
        reporter = msg.sender;
    }

    function setReporter(address reporter_) external onlyOwner {
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    function setGate(address gate_) external onlyOwner {
        gate = gate_;
        emit GateSet(gate_);
    }

    function setMaxStaleAge(uint64 seconds_) external onlyOwner {
        require(seconds_ >= 60, "too short");
        maxStaleAge = seconds_;
    }

    function setPrice(string calldata symbol, int256 price) external {
        require(msg.sender == reporter || msg.sender == owner(), "not reporter");
        require(price > 0, "price<=0");
        _prices[symbol] = PriceData(price, uint64(block.timestamp));
        emit PriceUpdated(symbol, price, uint64(block.timestamp));
        if (gate != address(0)) {
            IAssetGateRecorder(gate).recordPrice(symbol, price);
        }
    }

    /// @notice Reverts if the feed is missing or stale — the pool relies on this.
    function getPrice(string calldata symbol) external view returns (int256 price, uint64 updatedAt) {
        PriceData memory data = _prices[symbol];
        require(data.updatedAt != 0, "no price");
        require(block.timestamp - data.updatedAt <= maxStaleAge, "stale price");
        return (data.price, data.updatedAt);
    }

    /// @notice Last pushed price without the staleness check (for UI/reference).
    function getRawPrice(string calldata symbol) external view returns (int256 price, uint64 updatedAt) {
        PriceData memory data = _prices[symbol];
        return (data.price, data.updatedAt);
    }
}
